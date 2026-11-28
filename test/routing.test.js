import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.js";
import { LOW_CONFIDENCE_NOTICE } from "../src/client.js";
import { NATIVE_UNAVAILABLE_NOTICE } from "../src/native.js";
import { ROUTED_LOW_CONFIDENCE_NOTICE, requestedSources, routedPromptBaseline, routedToolSearch } from "../src/routing.js";

const FAILURE = /Memory retrieval unavailable/;
const session = { agentId: "main", trigger: "user", sessionKey: "agent:main:main", sessionId: "s-1" };

function harness(config = {}, toolCtx = session) {
  let beforePrompt;
  let tool;
  plugin.register({
    pluginConfig: { endpoint: "http://memory.test", ...config },
    logger: { warn: () => {}, debug: () => {} },
    on: (name, handler) => { if (name === "before_prompt_build") beforePrompt = handler; },
    registerTool: (factory, meta) => { if (meta?.name === "unified_memory_search") tool = factory(toolCtx); },
  });
  return { beforePrompt, tool };
}

const routed = (extra = {}) => ({ nativeRouting: { enabled: true, ...extra } });
const nativeHit = (path, score) => ({
  reference: { providerId: "memory-core", id: path, fragment: "L1-L5" },
  excerpt: `native note ${path}`,
  score,
  source: "memory",
  citations: [{ startLine: 1, endLine: 5 }],
});
const serviceItem = (id, path, source = "memory") => ({ id, text: `service ${id}`, source, path, line: 1, score: 2 });
const ok = (payload) => ({ ok: true, json: async () => payload });

/** Installs the fake native host and fetch stub for one test body. */
async function withBackends({ native, service }, run) {
  const previousFetch = globalThis.fetch;
  const previousHost = globalThis.__nativeMemoryHost;
  const requests = [];
  const nativeCalls = [];
  globalThis.fetch = async (url) => {
    const params = new URL(url).searchParams;
    const request = { query: params.get("q"), scope: params.get("scope"), profile: params.get("profile") };
    requests.push(request);
    return service(request);
  };
  globalThis.__nativeMemoryHost = {
    getActiveMemoryProvider: async (params) => {
      nativeCalls.push(params);
      if (native === "unavailable") return { provider: null, error: "memory plugin unavailable" };
      return {
        provider: {
          capabilities: { sources: ["memory", "sessions"] },
          search: async (request) => {
            if (native === "error") throw new Error("index broken");
            return { hits: typeof native === "function" ? native(request) : native, coverage: "complete" };
          },
          close: async () => {},
        },
      };
    },
  };
  try {
    return await run({ requests, nativeCalls });
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__nativeMemoryHost = previousHost;
  }
}

const fullCoverage = { main: "searched", archive: "searched", documents: "searched" };

test("routing off: tool and hook never touch native memory (behaviour unchanged)", async () => {
  await withBackends({
    native: [nativeHit("memory/a.md", 0.9)],
    service: () => ok({ results: [serviceItem("m1", "memory/a.md")], low_confidence: true }),
  }, async ({ requests, nativeCalls }) => {
    const { beforePrompt, tool } = harness();
    const output = await beforePrompt({ prompt: "what did we decide yesterday?" }, session);
    assert.match(output.prependContext, /service m1/);
    assert.ok(output.prependContext.includes(LOW_CONFIDENCE_NOTICE));
    const result = await tool.execute("call-1", { query: "decision" });
    assert.match(result.content[0].text, /service m1/);
    assert.equal(result.details.routing, undefined);
    assert.deepEqual(requests.map((r) => r.scope), ["all", "all"]);
    assert.equal(nativeCalls.length, 0);
  });
});

test("routed tool scope=all merges native notes with service documents and outputs", async () => {
  await withBackends({
    native: [nativeHit("memory/2026-11-20.md", 0.71)],
    service: () => ok({
      results: [
        serviceItem("copy", "memory/2026-11-20.md"),
        serviceItem("d1", "documents/policy.pdf.md", "document"),
        serviceItem("o1", "outputs/2026-11-28/report.md", "artifact"),
      ],
      coverage: fullCoverage,
    }),
  }, async ({ requests, nativeCalls }) => {
    const { tool } = harness(routed());
    const result = await tool.execute("call-2", { query: "what did we decide about the router" });
    assert.deepEqual(requests.map((r) => [r.scope, r.profile]), [["all", "tool"]]);
    assert.equal(nativeCalls.length, 1);
    assert.equal(nativeCalls[0].context.authority.sessionKey, "agent:main:main");
    const texts = result.details.results.map((item) => item.text);
    assert.deepEqual(texts, ["native note memory/2026-11-20.md", "service d1", "service o1"]);
    assert.match(result.content[0].text, /native-memory \/ memory\/2026-11-20.md/);
    assert.deepEqual(result.details.routing, { native: true, identifierLike: false });
    assert.equal(result.details.receipt.status, "found");
    assert.deepEqual(result.details.receipt.sources.searched, ["main", "archive", "documents"]);
    assert.equal(result.details.receipt.partialCoverage, false);
  });
});

test("routed tool keeps service copies for identifier-like queries (C.3 condition 5)", async () => {
  await withBackends({
    native: [nativeHit("memory/home.md", 0.4)],
    service: () => ok({ results: [serviceItem("exact", "memory/infra.md")], coverage: fullCoverage }),
  }, async ({ requests }) => {
    const { tool } = harness(routed());
    const result = await tool.execute("call-3", { query: "sensor.energy_daily_cost_home_12b", scope: "main" });
    assert.deepEqual(requests.map((r) => r.scope), ["main"]);
    assert.deepEqual(result.details.results.map((item) => item.text), ["native note memory/home.md", "service exact"]);
    assert.equal(result.details.routing.identifierLike, true);
    assert.deepEqual(result.details.receipt.sources.searched, ["main"]);
  });
});

test("routed tool leaves documents and archive scopes on the service only", async () => {
  await withBackends({
    native: [nativeHit("memory/a.md", 0.9)],
    service: () => ok({ results: [serviceItem("d1", "documents/a.md", "document")] }),
  }, async ({ requests, nativeCalls }) => {
    const { tool } = harness(routed());
    for (const scope of ["documents", "archive"]) {
      const result = await tool.execute(`call-${scope}`, { query: "insurance policy", scope });
      assert.match(result.content[0].text, /service d1/);
      assert.equal(result.details.routing, undefined);
    }
    assert.deepEqual(requests.map((r) => r.scope), ["documents", "archive"]);
    assert.equal(nativeCalls.length, 0);
  });
});

test("routed tool discloses weak native results (C.3 condition 2 / R8)", async () => {
  await withBackends({
    native: [nativeHit("memory/unrelated.md", 0.22)],
    service: () => ok({ results: [], coverage: fullCoverage }),
  }, async () => {
    const { tool } = harness(routed({ lowConfidenceMode: "score" }));
    const result = await tool.execute("call-4", { query: "warranty certificate for the grand piano" });
    assert.equal(result.details.lowConfidence, true);
    assert.ok(result.content[0].text.includes(ROUTED_LOW_CONFIDENCE_NOTICE));
    assert.ok(!result.content[0].text.includes(LOW_CONFIDENCE_NOTICE));
  });
  await withBackends({
    native: [nativeHit("memory/unrelated.md", 0.22)],
    service: () => ok({ results: [serviceItem("d1", "documents/piano.md", "document")], coverage: fullCoverage }),
  }, async () => {
    const { tool } = harness(routed({ lowConfidenceMode: "score" }));
    const result = await tool.execute("call-5", { query: "warranty certificate for the grand piano" });
    assert.equal(result.details.lowConfidence, false, "a strong service hit lifts the flag");
  });
  await withBackends({
    native: [nativeHit("memory/unrelated.md", 0.3)],
    service: () => ok({ results: [], coverage: fullCoverage }),
  }, async () => {
    const { tool } = harness(routed({ lowConfidenceMode: "score", lowConfidenceScore: 0.25 }));
    const result = await tool.execute("call-6", { query: "warranty certificate for the grand piano" });
    assert.equal(result.details.lowConfidence, false, "threshold is configurable");
  });
});

test("routed tool falls back to service copies and discloses when native is unavailable", async () => {
  for (const native of ["unavailable", "error"]) {
    await withBackends({
      native,
      service: () => ok({ results: [serviceItem("copy", "memory/a.md")], coverage: fullCoverage }),
    }, async () => {
      const { tool } = harness(routed());
      const result = await tool.execute("call-7", { query: "what did we decide about the router" });
      assert.match(result.content[0].text, /service copy/);
      assert.ok(result.content[0].text.includes(NATIVE_UNAVAILABLE_NOTICE));
      assert.deepEqual(result.details.routing, { native: false, identifierLike: false });
      assert.equal(result.details.receipt.partialCoverage, true, "no verified coverage after a failed lane");
    });
  }
  await withBackends({ native: [], service: () => ok({ results: [] }) }, async () => {
    const { tool } = harness(routed(), { agentId: "main" });
    const result = await tool.execute("call-8", { query: "anything" });
    assert.ok(result.content[0].text.includes(NATIVE_UNAVAILABLE_NOTICE), "no session authority fails closed");
    assert.match(result.content[0].text, /No memory results/);
    assert.notEqual(result.details.receipt.status, "absent");
  });
});

test("routed tool reports failure when both lanes fail and native-only results when the service fails", async () => {
  await withBackends({ native: "error", service: () => ({ ok: false, status: 503 }) }, async () => {
    const { tool } = harness(routed());
    const result = await tool.execute("call-9", { query: "anything" });
    assert.match(result.content[0].text, FAILURE);
    assert.equal(result.details.receipt.status, "unavailable");
  });
  await withBackends({ native: [nativeHit("memory/a.md", 0.8)], service: () => ({ ok: false, status: 503 }) }, async () => {
    const { tool } = harness(routed());
    const result = await tool.execute("call-10", { query: "anything" });
    assert.match(result.content[0].text, /native note memory\/a.md/);
    assert.match(result.content[0].text, /memory service lane unavailable/);
    assert.equal(result.details.receipt.partialCoverage, true);
  });
});

test("routed prompt hook does not query the service on ordinary turns (latency guard)", async () => {
  await withBackends({
    native: [nativeHit("memory/2026-11-27.md", 0.66)],
    service: () => ok({ results: [serviceItem("m1", "memory/x.md")] }),
  }, async ({ requests, nativeCalls }) => {
    const { beforePrompt } = harness(routed());
    const longPrompt = `Let us continue with yesterday's plan. ${"More context about the plan. ".repeat(80)}`;
    const output = await beforePrompt({ prompt: longPrompt }, session);
    assert.match(output.prependContext, /native note memory\/2026-11-27.md/);
    assert.equal(requests.length, 0, "no memory-sebg request at all");
    assert.equal(nativeCalls.length, 1);
    assert.deepEqual(nativeCalls[0].context.authority.sessionKey, "agent:main:main");
  });
});

test("routed prompt hook keeps the topic-triggered documents lane (E.3)", async () => {
  await withBackends({
    native: [nativeHit("memory/kids.md", 0.6)],
    service: (request) => ok({
      results: [serviceItem("d1", "documents/kita-contract.md", "document")],
      coverage: { main: "not_searched", archive: "not_searched", documents: request.scope === "documents" ? "searched" : "not_searched" },
    }),
  }, async ({ requests }) => {
    const { beforePrompt } = harness({ ...routed(), turnReceipts: true });
    const output = await beforePrompt({ prompt: "Which Kita do the kids attend?" }, session);
    assert.deepEqual(requests.map((r) => r.scope), ["documents"]);
    assert.match(output.prependContext, /native note memory\/kids.md/);
    assert.match(output.prependContext, /service d1/);
    assert.doesNotMatch(output.prependContext, /coverage for this turn is unverified/);
  });
});

test("routed prompt hook adds a service main lane for identifier-like prompts or by config", async () => {
  await withBackends({
    native: [nativeHit("memory/home.md", 0.5)],
    service: () => ok({ results: [serviceItem("exact", "memory/infra.md")], coverage: { main: "searched", archive: "not_searched", documents: "not_searched" } }),
  }, async ({ requests }) => {
    const { beforePrompt } = harness(routed());
    const output = await beforePrompt({ prompt: "what is sensor.energy_daily_cost_home_12b showing" }, session);
    assert.deepEqual(requests.map((r) => [r.scope, r.profile]), [["main", "prompt"]]);
    assert.match(output.prependContext, /service exact/);
  });
  await withBackends({
    native: [nativeHit("memory/home.md", 0.5)],
    service: () => ok({ results: [] }),
  }, async ({ requests }) => {
    const { beforePrompt } = harness(routed({ promptServiceScope: "all" }));
    await beforePrompt({ prompt: "how was the weekend" }, session);
    assert.deepEqual(requests.map((r) => r.scope), ["all"]);
  });
});

test("routed prompt hook falls back to the service main scope when native fails", async () => {
  await withBackends({
    native: "error",
    service: () => ok({ results: [serviceItem("copy", "memory/a.md")] }),
  }, async ({ requests }) => {
    const { beforePrompt } = harness(routed());
    const output = await beforePrompt({ prompt: "what did we decide yesterday" }, session);
    assert.deepEqual(requests.map((r) => r.scope), ["main"]);
    assert.match(output.prependContext, /service copy/);
    assert.ok(output.prependContext.includes(NATIVE_UNAVAILABLE_NOTICE));
  });
  await withBackends({ native: "error", service: () => ({ ok: false, status: 500 }) }, async () => {
    const { beforePrompt } = harness(routed());
    const output = await beforePrompt({ prompt: "what did we decide yesterday" }, session);
    assert.match(output.prependContext, FAILURE);
  });
  await withBackends({ native: "error", service: () => ({ ok: false, status: 500 }) }, async () => {
    const { beforePrompt } = harness({ ...routed(), turnReceipts: true });
    const output = await beforePrompt({ prompt: "what did we decide yesterday" }, session);
    assert.match(output.prependContext, FAILURE);
  });
});

test("routed prompt hook discloses weak native results in both output modes", async () => {
  for (const turnReceipts of [false, true]) {
    await withBackends({ native: [nativeHit("memory/unrelated.md", 0.32)], service: () => ok({ results: [] }) }, async () => {
      const { beforePrompt } = harness({ ...routed({ lowConfidenceMode: "lexical", lowConfidenceScore: 0.45 }), turnReceipts });
      const output = await beforePrompt({ prompt: "insurance policy for the quokka" }, session);
      assert.ok(output.prependContext.includes(ROUTED_LOW_CONFIDENCE_NOTICE), `turnReceipts=${turnReceipts}`);
      assert.ok(!output.prependContext.includes(NATIVE_UNAVAILABLE_NOTICE));
    });
  }
  await withBackends({ native: [nativeHit("memory/a.md", 0.8)], service: () => ok({ results: [] }) }, async () => {
    const { beforePrompt } = harness({ ...routed(), turnReceipts: true });
    const output = await beforePrompt({ prompt: "what did we decide yesterday" }, session);
    assert.ok(!output.prependContext.includes(ROUTED_LOW_CONFIDENCE_NOTICE));
    assert.doesNotMatch(output.prependContext, /unverified/);
  });
  await withBackends({ native: "error", service: () => ok({ results: [serviceItem("copy", "memory/a.md")] }) }, async () => {
    const { beforePrompt } = harness({ ...routed(), turnReceipts: true });
    const output = await beforePrompt({ prompt: "what did we decide yesterday" }, session);
    assert.ok(output.prependContext.includes(NATIVE_UNAVAILABLE_NOTICE));
  });
});

test("routing helpers: requested sources and lane outcomes", async () => {
  assert.equal(requestedSources(undefined), undefined);
  assert.equal(requestedSources({ main: "not_searched" }), undefined);
  assert.deepEqual(requestedSources({ main: "searched", archive: "not_searched", documents: "unavailable" }), ["main", "documents"]);

  const settings = { timeoutMs: 1000, sources: ["memory"], lowConfidenceScore: 0.35, promptServiceScope: "none" };
  const nativeOk = async () => ({ results: [{ text: "n", lane: "native", path: "memory/a.md", line: 1, score: 0.9 }], warnings: [] });
  assert.equal(await routedToolSearch({ query: "q", scope: "documents", settings }), undefined);

  // Service without coverage keeps coverage unknown; service main not searched is reported.
  const noCoverage = await routedToolSearch({
    query: "plain question here", scope: "all", ctx: {}, config: {}, settings,
    searchNative: nativeOk,
    searchService: async () => ({ results: [], warnings: [] }),
  });
  assert.equal(noCoverage.coverage, undefined);
  const mainUnavailable = await routedToolSearch({
    query: "plain question here", scope: "main", ctx: {}, config: { maxResults: 2 }, settings,
    searchNative: nativeOk,
    searchService: async () => ({ results: [], warnings: [], coverage: { main: "unavailable" } }),
  });
  assert.equal(mainUnavailable.coverage.main, "unavailable");
  const mainMissing = await routedToolSearch({
    query: "plain question here", scope: "main", ctx: {}, config: {}, settings,
    searchNative: nativeOk,
    searchService: async () => ({ results: [], warnings: [], coverage: {} }),
  });
  assert.equal(mainMissing.coverage.main, "unavailable");

  // Fallback is skipped when no budget remains; then both lanes count as failed.
  await assert.rejects(routedPromptBaseline({
    prompt: "q", ctx: {}, config: {}, settings, timeoutMs: 100,
    searchNative: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); throw new Error("down"); },
    searchService: async () => { throw new Error("must not run"); },
  }), /all memory lanes unavailable/);
});

test("routing edge cases: sparse responses, receipt source lists, identifier prompt with native down", async () => {
  const { buildReceipt } = await import("../src/receipt.js");
  assert.deepEqual(buildReceipt({ scope: [], startedAt: 0, endedAt: 1 }).sources.searched, ["main", "archive", "documents"]);
  assert.deepEqual(buildReceipt({ scope: ["documents"], startedAt: 0, endedAt: 1 }).sources.searched, ["documents"]);

  const settings = { timeoutMs: 1000, sources: ["memory"], lowConfidenceScore: 0.35, promptServiceScope: "none" };
  const sparse = await routedToolSearch({
    query: "plain question here", scope: "all", ctx: {}, config: {}, settings,
    searchNative: async () => ({ results: [] }),
    searchService: async () => ({ results: [{ text: "s", path: "documents/a.md", line: 1 }] }),
  });
  assert.deepEqual(sparse.warnings, []);
  assert.equal(sparse.results.length, 1);

  const baseline = await routedPromptBaseline({
    prompt: "check PR #24", ctx: {}, config: { maxResults: 1 }, settings, timeoutMs: 1000,
    searchNative: async () => { throw new Error("down"); },
    searchService: async (_query, options) => ({ results: [{ text: options.scope, path: "memory/a.md", line: 1 }, { text: "more", path: "memory/b.md", line: 1 }], warnings: [] }),
  });
  assert.equal(baseline.serviceScope, "main");
  assert.equal(baseline.nativeUnavailable, true);
  assert.deepEqual(baseline.results.map((item) => item.text), ["main"]);
});

test("default lowConfidenceMode off: weak native scores are not flagged; routed hook applies the source quota", async () => {
  await withBackends({ native: [nativeHit("memory/unrelated.md", 0.22)], service: () => ok({ results: [] }) }, async () => {
    const { beforePrompt, tool } = harness(routed());
    const output = await beforePrompt({ prompt: "insurance policy for the quokka" }, session);
    assert.ok(!output.prependContext.includes(ROUTED_LOW_CONFIDENCE_NOTICE));
    const result = await tool.execute("call-q", { query: "insurance policy for the quokka" });
    assert.equal(result.details.lowConfidence, false);
  });
  await withBackends({
    native: (request) => request.sources.length === 1 && request.sources[0] === "sessions"
      ? [1, 2, 3, 4].map((n) => ({ ...nativeHit(`sessions/s${n}.jsonl`, 0.8 - n / 100), source: "sessions" }))
      : [1, 2, 3, 4].map((n) => nativeHit(`memory/n${n}.md`, 0.6 - n / 100)),
    service: () => ok({ results: [] }),
  }, async () => {
    const { tool } = harness(routed({ sources: ["memory", "sessions"] }));
    const result = await tool.execute("call-r", { query: "what did we decide about the router" });
    const sources = result.details.results.map((item) => item.source);
    assert.equal(sources.filter((s) => s === "native-sessions").length, 2);
    assert.equal(sources.filter((s) => s === "native-memory").length, 3);
  });
});
