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

test("prompt hook makes one bounded exact-entity follow-up when baseline results omit the target", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    requests.push(parsed.searchParams.get("q"));
    const isTargeted = requests.length === 2;
    return {
      ok: true,
      json: async () => ({
        results: [isTargeted
          ? { ...result("Riley Sample joined Example Corp..", "memory"), path: "memory/riley.md", line: 9 }
          : result("General hiring context", "memory")],
        coverage: { main: "searched", archive: "searched", documents: "searched" },
      }),
    };
  };
  try {
    const instance = harness({ endpoint: "http://memory.test", turnReceipts: true, maxResults: 5 });
    const output = await instance.beforePrompt(
      { prompt: 'What is known about "Riley Sample"?' },
      { agentId: "main" },
    );
    assert.equal(requests.length, 2);
    assert.equal(requests[1], "Riley Sample");
    assert.match(output.prependContext, /Riley Sample joined Example Corp./);
    assert.match(instance.traces[0], /"status":"found"/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("prompt hook folds a current-prompt alias pair into the same single follow-up", async () => {
  const previousFetch = globalThis.fetch;
  const queries = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    queries.push(parsed.searchParams.get("q"));
    return {
      ok: true,
      json: async () => ({ results: [queries.length === 1
        ? result("General context")
        : { ...result("Riley Jordan profile"), path: "memory/riley.md", line: 9 }] }),
    };
  };
  try {
    const instance = harness({ endpoint: "http://memory.test" });
    const output = await instance.beforePrompt(
      { prompt: "Please check Riley aka Jordan." },
      { agentId: "main" },
    );
    assert.equal(queries.length, 2);
    assert.equal(queries[1], "Riley Jordan");
    assert.match(output.prependContext, /Riley Jordan profile/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("prompt hook skips a targeted lookup when baseline results already contain the entity", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({ results: [result('Riley Sample profile')] }),
    };
  };
  try {
    const instance = harness({ endpoint: "http://memory.test" });
    const output = await instance.beforePrompt(
      { prompt: 'Tell me about "Riley Sample".' },
      { agentId: "main" },
    );
    assert.equal(calls, 1);
    assert.match(output.prependContext, /Riley Sample profile/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("prompt hook uses default target limits and discloses a failed follow-up in legacy mode", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 2) throw new Error("targeted lookup failed");
    return { ok: true, json: async () => ({ results: [result("General memory") ] }) };
  };
  try {
    const instance = harness({ endpoint: "http://memory.test", timeoutMs: 1000 });
    const output = await instance.beforePrompt(
      { prompt: 'Find "Riley Sample".' },
      { agentId: "main" },
    );
    assert.equal(calls, 2);
    assert.match(output.prependContext, /do not claim that entity was absent/);
    assert.equal(instance.warnings.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("prompt hook bounds successful follow-up results to the default limit", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({
        results: calls === 1
          ? [result("General context")]
          : [{ ...result("Riley Sample fact"), path: "memory/riley.md", line: 9 }],
      }),
    };
  };
  try {
    const instance = harness({ endpoint: "http://memory.test" });
    const output = await instance.beforePrompt(
      { prompt: 'Find "Riley Sample".' },
      { agentId: "main" },
    );
    assert.equal(calls, 2);
    assert.match(output.prependContext, /Riley Sample fact/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("prompt hook routes an explicit document path follow-up to the documents source", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    calls.push({ query: parsed.searchParams.get("q"), scope: parsed.searchParams.get("scope") });
    return {
      ok: true,
      json: async () => ({
        results: calls.length === 1
          ? [result("General context")]
          : [{ ...result("Exact document match"), path: "memory/facts/owner.json", line: 3 }],
        coverage: calls.length === 1
          ? { main: "searched", archive: "searched", documents: "searched" }
          : { main: "not_searched", archive: "not_searched", documents: "searched" },
      }),
    };
  };
  try {
    const instance = harness({ endpoint: "http://memory.test", turnReceipts: true });
    const output = await instance.beforePrompt(
      { prompt: "Check memory/facts/owner.json" },
      { agentId: "main" },
    );
    assert.deepEqual(calls, [
      { query: "Check memory/facts/owner.json", scope: "all" },
      { query: "memory/facts/owner.json", scope: "documents" },
    ]);
    assert.match(output.prependContext, /Exact document match/);
    assert.match(instance.traces[0], /"searched":\["main","archive","documents"\]/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("failed entity follow-up is disclosed and cannot become a verified absence", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 2) throw new Error("targeted lookup failed");
    return {
      ok: true,
      json: async () => ({
        results: [],
        coverage: { main: "searched", archive: "searched", documents: "searched" },
      }),
    };
  };
  try {
    const instance = harness({ endpoint: "http://memory.test", turnReceipts: true });
    const output = await instance.beforePrompt(
      { prompt: 'Find "Riley Sample".' },
      { agentId: "main" },
    );
    assert.match(output.prependContext, /not every requested source was confirmed as searched|coverage is unverified/i);
    assert.doesNotMatch(output.prependContext, /This is a verified absence/i);
    assert.match(instance.traces[0], /"status":"unverified"/);
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
