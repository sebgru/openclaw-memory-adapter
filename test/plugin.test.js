import test from "node:test";
import assert from "node:assert/strict";
import plugin, { eligible, listAllows } from "../index.js";

function harness(config = {}) {
  let beforePrompt;
  let registeredTool;
  const warnings = [];
  const traces = [];
  plugin.register({
    pluginConfig: config,
    logger: {
      warn: (message) => warnings.push(message),
      debug: (message) => traces.push(message),
    },
    on: (name, handler) => {
      if (name === "before_prompt_build") beforePrompt = handler;
    },
    registerTool: (factory) => { registeredTool = factory({}); },
  });
  return { beforePrompt, tool: registeredTool, warnings, traces };
}

const result = (text = "Remembered fact", source = "memory") => ({
  text,
  source,
  path: "memory/fact.md",
  line: 4,
});

test("listAllows and eligible enforce configured agent/chat scopes", () => {
  assert.equal(listAllows(undefined, "main"), true);
  assert.equal(listAllows([], "main"), true);
  assert.equal(listAllows(["main"], "main"), true);
  assert.equal(listAllows(["other"], "main"), false);
  assert.equal(eligible({ prompt: "question" }, { agentId: "main" }, {}), true);
  assert.equal(eligible({ prompt: "question" }, { agentId: "main" }, { enabled: false }), false);
  assert.equal(eligible({ prompt: "question" }, { agentId: "main" }, { agents: ["other"] }), false);
  assert.equal(eligible({ prompt: "question" }, { agentId: "main", chatType: "direct" }, { allowedChatTypes: ["group"] }), false);
  assert.equal(eligible({ prompt: "question" }, { agentId: "main", chatId: "1" }, { allowedChatIds: ["2"] }), false);
  assert.equal(eligible({ prompt: "  " }, { agentId: "main" }, {}), false);
});

test("prompt hook keeps legacy context behavior when receipts are disabled", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ results: [result()], warnings: ["partial source"], conflicts: [] }),
  });
  try {
    const instance = harness({ endpoint: "http://memory.test", maxContextLength: 1000 });
    const output = await instance.beforePrompt({ prompt: "question" }, { agentId: "main" });
    assert.match(output.prependContext, /Remembered fact/);
    assert.equal(instance.warnings.length, 1);
    assert.equal(instance.traces.length, 0);

    const disabled = harness({ enabled: false });
    assert.equal(await disabled.beforePrompt({ prompt: "question" }, { agentId: "main" }), undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("prompt hook creates ephemeral bounded receipt trace when enabled", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ results: [result()], warnings: ["partial source"], conflicts: ["A differs from B"] }),
  });
  try {
    const instance = harness({ endpoint: "http://memory.test", turnReceipts: true, maxContextLength: 1000 });
    const output = await instance.beforePrompt(
      { prompt: "question", currentUserMessageId: "message-1" },
      { agentId: "main", runId: "run-1" },
    );
    assert.match(output.prependContext, /Remembered fact/);
    assert.match(output.prependContext, /conflicting evidence/);
    assert.equal(instance.traces.length, 1);
    assert.match(instance.traces[0], /"schemaVersion":2/);

    const fallback = harness({ endpoint: "http://memory.test", turnReceipts: true });
    await fallback.beforePrompt({ prompt: "question" }, { agentId: "main", runId: "run-2" });
    assert.match(fallback.traces[0], /"turnId":"run-2"/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("prompt hook distinguishes retrieval failure in legacy and receipt modes", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("service offline"); };
  try {
    const legacy = harness({ endpoint: "http://memory.test" });
    const legacyOutput = await legacy.beforePrompt({ prompt: "question" }, { agentId: "main" });
    assert.match(legacyOutput.prependContext, /Memory retrieval unavailable/);
    assert.equal(legacy.warnings.length, 1);

    const receipts = harness({ endpoint: "http://memory.test", turnReceipts: true });
    const receiptOutput = await receipts.beforePrompt({ prompt: "question" }, { agentId: "main" });
    assert.match(receiptOutput.prependContext, /Memory retrieval unavailable/);
    assert.match(receipts.traces[0], /"status":"unavailable"/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("search tool exposes found, absent, partial, and unavailable versioned receipts", async () => {
  const previousFetch = globalThis.fetch;
  try {
    const instance = harness({ endpoint: "http://memory.test", maxContextLength: 1000 });
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: [result()], warnings: [], conflicts: [] }) });
    const found = await instance.tool.execute("tool-turn-1", { query: "fact", scope: "all" });
    assert.equal(found.details.receipt.schemaVersion, 2);
    assert.equal(found.details.receipt.status, "found");
    assert.equal(found.details.receipt.turnId, "tool-turn-1");
    assert.equal(Object.hasOwn(found.details.receipt, "query"), false);
    assert.equal(Object.hasOwn(found.details.receipt, "results"), false);
    assert.match(found.content[0].text, /Remembered fact/);

    const generated = await instance.tool.execute(undefined, { query: "fact" });
    assert.match(generated.details.receipt.turnId, /^[0-9a-f-]{36}$/i);

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: [], warnings: [], conflicts: [] }) });
    const absent = await instance.tool.execute("tool-turn-2", { query: "missing" });
    assert.equal(absent.details.receipt.status, "absent");
    assert.match(absent.content[0].text, /No memory results/);

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: [result()], warnings: ["partial"], conflicts: [] }) });
    const partial = await instance.tool.execute("tool-turn-3", { query: "fact", maxResults: 1 });
    assert.equal(partial.details.receipt.partialCoverage, true);
    assert.deepEqual(partial.details.receipt.sources.unknownCoverage, ["main", "archive", "documents"]);
    assert.match(partial.content[0].text, /Warnings: partial/);

    globalThis.fetch = async () => { throw new Error("service offline"); };
    const unavailable = await instance.tool.execute("tool-turn-4", { query: "fact" });
    assert.equal(unavailable.details.receipt.status, "unavailable");
    assert.match(unavailable.content[0].text, /Memory retrieval unavailable/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("tool receipt: zero results is absent only with service-confirmed coverage; timeout stays unavailable", async () => {
  const previousFetch = globalThis.fetch;
  try {
    const instance = harness({ endpoint: "http://memory.test" });
    const full = { main: "searched", archive: "searched", documents: "searched" };
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: [], coverage: full }) });
    const absent = await instance.tool.execute("c1", { query: "missing" });
    assert.equal(absent.details.receipt.status, "absent");
    assert.deepEqual(absent.details.receipt.sources.absent, ["main", "archive", "documents"]);

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: [], coverage: { ...full, archive: "unavailable" } }) });
    const partial = await instance.tool.execute("c2", { query: "missing" });
    assert.equal(partial.details.receipt.status, "unavailable");
    assert.deepEqual(partial.details.receipt.sources.absent, ["main", "documents"]);

    globalThis.fetch = async () => { throw new Error("timeout"); };
    const timeout = await instance.tool.execute("c3", { query: "missing" });
    assert.equal(timeout.details.receipt.status, "unavailable");
    assert.deepEqual(timeout.details.receipt.sources.absent, []);

    const strict = harness({ endpoint: "http://memory.test", requireServiceCoverage: true });
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: [] }) });
    const unconfirmed = await strict.tool.execute("c4", { query: "missing" });
    assert.equal(unconfirmed.details.receipt.status, "unverified");
    assert.deepEqual(unconfirmed.details.receipt.sources.absent, []);
    assert.deepEqual(unconfirmed.details.receipt.sources.unknownCoverage, ["main", "archive", "documents"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("prompt hook receipt honors requireServiceCoverage with a zero-result response", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: [] }) });
  try {
    const strict = harness({ endpoint: "http://memory.test", turnReceipts: true, requireServiceCoverage: true });
    const output = await strict.beforePrompt({ prompt: "question" }, { agentId: "main" });
    assert.match(output.prependContext, /did not confirm that every requested source/);
    assert.doesNotMatch(output.prependContext, /This is a verified absence/);
    assert.match(strict.traces[0], /"unverified"/);
    assert.match(strict.traces[0], /"unknownCoverage":\["main","archive","documents"\]/);

    // coverage present but invalid must not fall back to legacy inference
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: [], coverage: {} }) });
    const invalid = harness({ endpoint: "http://memory.test", turnReceipts: true });
    const invalidOut = await invalid.beforePrompt({ prompt: "question" }, { agentId: "main" });
    assert.doesNotMatch(invalidOut.prependContext, /This is a verified absence/);
    assert.match(invalid.traces[0], /"unverified"/);

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: [] }) });
    const legacy = harness({ endpoint: "http://memory.test", turnReceipts: true });
    const legacyOut = await legacy.beforePrompt({ prompt: "question" }, { agentId: "main" });
    assert.match(legacyOut.prependContext, /verified absence/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
