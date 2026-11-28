import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LOW_CONFIDENCE_SCORE,
  createNativeSearch,
  isIdentifierLike,
  applySourceQuota,
  isNativeLowConfidence,
  lacksLexicalEvidence,
  mergeRoutedResults,
  nativeLowConfidence,
  queryTerms,
  nativeRoutingSettings,
  normalizeNativeHits,
} from "../src/native.js";

const hit = (path, score, source = "memory", startLine = 3) => ({
  reference: { providerId: "memory-core", id: path, fragment: `L${startLine}-L${startLine + 4}` },
  excerpt: `excerpt of ${path}`,
  score,
  source,
  citations: [{ label: `${path}#L${startLine}`, startLine, endLine: startLine + 4 }],
});

/** Fake host lease that records the open/search/close calls. */
function fakeHost({ hits = [], capabilities = { sources: ["memory", "sessions"] }, provider, searchImpl } = {}) {
  const calls = { open: [], search: [], closed: 0 };
  const lease = provider === null ? null : {
    capabilities,
    search: async (request) => {
      calls.search.push(request);
      return searchImpl ? searchImpl(request) : { hits, coverage: "complete" };
    },
    close: async () => { calls.closed += 1; },
  };
  return {
    calls,
    host: { getActiveMemoryProvider: async (params) => { calls.open.push(params); return { provider: lease }; } },
  };
}

const ctx = { agentId: "main", sessionKey: "agent:main:main", sessionId: "s-1" };

test("nativeRoutingSettings defaults to off with the C.3 threshold", () => {
  assert.deepEqual(nativeRoutingSettings(undefined), {
    enabled: false,
    sources: ["memory"],
    lowConfidenceMode: "off",
    lowConfidenceScore: 0.35,
    sourceQuota: { memory: 3, sessions: 2 },
    timeoutMs: 2500,
    promptServiceScope: "none",
  });
  assert.equal(DEFAULT_LOW_CONFIDENCE_SCORE, 0.35);
  assert.equal(nativeRoutingSettings({ enabled: "yes" }).enabled, false);
  assert.equal(nativeRoutingSettings([]).enabled, false);
  const custom = nativeRoutingSettings({
    enabled: true,
    sources: ["sessions", "memory", "sessions", "bogus"],
    lowConfidenceScore: 0.5,
    timeoutMs: 99999,
    promptServiceScope: "main",
    lowConfidenceMode: "lexical",
    sourceQuota: { memory: 4, sessions: 0 },
  });
  assert.deepEqual(custom, {
    enabled: true,
    sources: ["sessions", "memory"],
    lowConfidenceMode: "lexical",
    lowConfidenceScore: 0.5,
    sourceQuota: { memory: 4, sessions: 0 },
    timeoutMs: 6000,
    promptServiceScope: "main",
  });
  assert.equal(nativeRoutingSettings({ lowConfidenceMode: "margin" }).lowConfidenceMode, "off");
  assert.deepEqual(nativeRoutingSettings({ sourceQuota: { memory: 11, sessions: -1 } }).sourceQuota, { memory: 3, sessions: 2 });
  assert.deepEqual(nativeRoutingSettings({ sourceQuota: [] }).sourceQuota, { memory: 3, sessions: 2 });
  assert.equal(nativeRoutingSettings({ lowConfidenceScore: 2 }).lowConfidenceScore, 0.35);
  assert.equal(nativeRoutingSettings({ lowConfidenceScore: 0 }).lowConfidenceScore, 0);
  assert.equal(nativeRoutingSettings({ timeoutMs: 10 }).timeoutMs, 250);
  assert.deepEqual(nativeRoutingSettings({ sources: ["bogus"] }).sources, ["memory"]);
  assert.equal(nativeRoutingSettings({ promptServiceScope: "documents" }).promptServiceScope, "none");
});

test("isIdentifierLike flags exact identifiers and leaves natural questions alone", () => {
  for (const query of [
    "sensor.energy_daily_cost_home_12b",
    "what does X-02 cover",
    "status of PR #24",
    "changes in v1.13.0",
    "open README.md please",
    "commit 669223f",
    "mail from someone@example.org",
    "the B2B-7 contract",
  ]) assert.equal(isIdentifierLike(query), true, query);
  for (const query of [
    "what did we decide about the Kita yesterday",
    "Garantie Flügel Rechnung",
    "гарантия на робот-газонокосилку",
    "How are you today?",
    "",
  ]) assert.equal(isIdentifierLike(query), false, query);
  assert.equal(isIdentifierLike("Energy sensor"), false);
  assert.equal(isIdentifierLike("Energy sensor", { shortQueryWords: 3 }), true);
});

test("normalizeNativeHits maps provider hits to labelled adapter results", () => {
  const results = normalizeNativeHits([
    hit("memory/2026-11-20.md", 0.61),
    hit("sessions/abc.jsonl", 0.4, "sessions", 0),
    { excerpt: "  " },
    null,
    { excerpt: "x".repeat(60), reference: {}, score: "n/a" },
  ], 10, 40);
  assert.equal(results.length, 3);
  assert.deepEqual(results[0], {
    text: "excerpt of memory/2026-11-20.md",
    source: "native-memory",
    score: 0.61,
    lane: "native",
    id: "native:memory/2026-11-20.md#L3-L7",
    path: "memory/2026-11-20.md",
    line: 3,
    provenance: { source: "native-memory", path: "memory/2026-11-20.md", line: 3 },
  });
  assert.equal(results[1].source, "native-sessions");
  assert.equal(results[1].line, 0);
  assert.equal(results[2].text, `${"x".repeat(40)}…`);
  assert.equal(results[2].score, undefined);
  assert.equal(results[2].path, undefined);
  assert.deepEqual(normalizeNativeHits(undefined, 5), []);
  assert.equal(normalizeNativeHits([hit("a.md", 1), hit("b.md", 1)], 1).length, 1);
});

test("isNativeLowConfidence uses the top score against the threshold", () => {
  assert.equal(isNativeLowConfidence([{ score: 0.22 }, { score: 0.1 }], 0.35), true);
  assert.equal(isNativeLowConfidence([{ score: 0.32 }], 0.35), true);
  assert.equal(isNativeLowConfidence([{ score: 0.35 }], 0.35), false);
  assert.equal(isNativeLowConfidence([{ score: 0.2 }, { score: 0.5 }], 0.35), false);
  assert.equal(isNativeLowConfidence([], 0.35), false);
  assert.equal(isNativeLowConfidence([{ score: undefined }], 0.35), false, "unknown score is not weak");
  assert.equal(isNativeLowConfidence([{ score: 0.1 }], 0), false, "threshold 0 disables");
  assert.equal(isNativeLowConfidence(undefined, 0.35), false);
});

test("searchNative opens a session-bound lease, searches requested sources and closes it", async () => {
  const { host, calls } = fakeHost({ hits: [hit("memory/a.md", 0.7)], capabilities: { sources: ["memory"] } });
  const audience = { kind: "owner-private", agentId: "main" };
  let audienceChecks = 0;
  const api = { config: { marker: "cfg" } };
  const search = createNativeSearch(api, { loadHost: async () => host });
  const response = await search("  where is the note  ", {
    ctx: { ...ctx, sandboxed: true, memoryAudience: audience, assertMemoryAudienceCurrent: () => { audienceChecks += 1; } },
    maxResults: 4,
    sources: ["memory", "sessions"],
  });
  assert.equal(response.results.length, 1);
  assert.equal(response.lowConfidence, false);
  assert.deepEqual(response.warnings, []);
  const [open] = calls.open;
  assert.equal(open.cfg, api.config);
  assert.equal(open.agentId, "main");
  assert.deepEqual(open.context.authority, {
    kind: "session",
    sessionKey: "agent:main:main",
    sessionId: "s-1",
    sandboxed: true,
    audience,
  });
  open.context.assertCurrent();
  assert.equal(audienceChecks, 1);
  assert.ok(open.context.signal instanceof AbortSignal);
  assert.deepEqual(calls.search, [{ query: "where is the note", maxResults: 4, minScore: 0, sources: ["memory"] }]);
  assert.equal(calls.closed, 1);
});

test("searchNative prefers the current runtime config and flags weak or partial results", async () => {
  const { host, calls } = fakeHost({
    searchImpl: () => ({ hits: [hit("memory/a.md", 0.22)], coverage: "partial", warning: "stale" }),
  });
  const current = { marker: "current" };
  const search = createNativeSearch({ config: {}, runtime: { config: { current: () => current } } }, { loadHost: async () => host });
  const response = await search("q", { ctx: { sessionKey: "k" }, lowConfidenceMode: "score" });
  assert.equal(calls.open[0].cfg, current);
  assert.equal(calls.open[0].agentId, "main");
  assert.deepEqual(calls.open[0].context.authority, { kind: "session", sessionKey: "k", sandboxed: false });
  calls.open[0].context.assertCurrent();
  assert.equal(response.lowConfidence, true);
  assert.deepEqual(response.warnings, ["native: index coverage partial"]);
});

test("searchNative fails closed without session authority or provider", async () => {
  let loaded = 0;
  const search = createNativeSearch({}, { loadHost: async () => { loaded += 1; return fakeHost().host; } });
  await assert.rejects(search("q", { ctx: { agentId: "main" } }), /session authority/);
  await assert.rejects(search("q", {}), /session authority/);
  await assert.rejects(search("   ", { ctx }), /must not be empty/);
  assert.equal(loaded, 0, "no host access without authority");

  await assert.rejects(createNativeSearch({}, { loadHost: async () => ({}) })("q", { ctx }), /API unavailable/);
  await assert.rejects(createNativeSearch({}, { loadHost: async () => fakeHost({ provider: null }).host })("q", { ctx }), /provider unavailable/);
  const memoryOnly = fakeHost({ capabilities: { sources: ["memory"] } });
  await assert.rejects(
    createNativeSearch({}, { loadHost: async () => memoryOnly.host })("q", { ctx, sources: ["sessions"] }),
    /requested sources/,
  );
  assert.equal(memoryOnly.calls.closed, 1, "lease is released after a rejected request");
  await assert.rejects(createNativeSearch({}, { loadHost: async () => { throw new Error("no module"); } })("q", { ctx }), /no module/);
});

test("searchNative times out, honours a parent abort and still closes the lease", async () => {
  const slow = fakeHost({ searchImpl: () => new Promise(() => {}) });
  const search = createNativeSearch({}, { loadHost: async () => slow.host });
  await assert.rejects(search("q", { ctx, timeoutMs: 20 }), /timed out/);
  assert.equal(slow.calls.closed, 1);

  const parent = new AbortController();
  parent.abort();
  await assert.rejects(search("q", { ctx, signal: parent.signal }), /timed out/);

  const later = new AbortController();
  const pending = search("q", { ctx, signal: later.signal, timeoutMs: 5000 });
  setTimeout(() => later.abort(), 10);
  await assert.rejects(pending, /timed out/);

  const failingClose = fakeHost({ hits: [hit("memory/a.md", 0.9)] });
  const lease = await failingClose.host.getActiveMemoryProvider({});
  lease.provider.close = async () => { throw new Error("close failed"); };
  const resilient = createNativeSearch({}, { loadHost: async () => ({ getActiveMemoryProvider: async () => lease }) });
  assert.equal((await resilient("q", { ctx })).results.length, 1);
});

test("mergeRoutedResults interleaves lanes and drops service copies of native-owned notes", () => {
  const native = [
    { text: "n1", lane: "native", path: "memory/a.md", line: 3 },
    { text: "n2", lane: "native", path: "memory/b.md", line: 1 },
  ];
  const service = [
    { text: "copy", source: "memory", path: "memory/a.md", line: 3 },
    { text: "root", source: "memory", path: "MEMORY.md", line: 1 },
    { text: "doc", source: "document", path: "documents/x.pdf.md", line: 1 },
    { text: "output", source: "artifact", path: "outputs/2026-11-28/r.md", line: 1 },
    { text: "plain" },
  ];
  assert.deepEqual(mergeRoutedResults(native, service, 10).map((item) => item.text), ["n1", "doc", "n2", "output", "plain"]);
  assert.deepEqual(
    mergeRoutedResults(native, service, 10, { keepServiceCopies: true }).map((item) => item.text),
    ["n1", "n2", "root", "doc", "output", "plain"],
    "exact path/line duplicates collapse even when copies are kept",
  );
  assert.deepEqual(mergeRoutedResults(native, service, 3).map((item) => item.text), ["n1", "doc", "n2"]);
  assert.deepEqual(mergeRoutedResults(undefined, undefined, 5), []);
});

test("native helpers tolerate sparse input", async () => {
  assert.equal(isIdentifierLike(undefined), false);
  const results = normalizeNativeHits([
    { reference: { id: "memory/no-fragment.md" }, excerpt: "text", score: 0.5 },
    { reference: { id: "memory/empty.md" } },
  ], 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "native:memory/no-fragment.md");
  assert.equal(results[0].line, undefined);
  const search = createNativeSearch({}, { loadHost: async () => fakeHost().host });
  await assert.rejects(search(undefined, { ctx }), /must not be empty/);
  const noCapabilities = fakeHost({ hits: [hit("memory/a.md", 0.9)], capabilities: {} });
  const legacy = await createNativeSearch({}, { loadHost: async () => noCapabilities.host })("q", { ctx, sources: ["memory", "sessions"] });
  assert.equal(legacy.results.length, 1);
  assert.deepEqual(noCapabilities.calls.search[0].sources, ["memory"], "unknown capabilities fall back to memory only");
  assert.deepEqual(
    mergeRoutedResults([{ text: "a", lane: "native", path: "outputs/x.md" }], [{ text: "b", path: "outputs/x.md" }], 5).map((item) => item.text),
    ["a"],
    "path without line still deduplicates",
  );
});

test("lowConfidenceMode: off by default, score-only, or lexical evidence plus score", async () => {
  const weak = [{ text: "holiday packing list", path: "memory/trip.md", score: 0.4 }];
  const query = "warranty certificate for the grand piano";
  assert.equal(nativeLowConfidence(weak, query), false, "off by default");
  assert.equal(nativeLowConfidence(weak, query, { mode: "score", score: 0.45 }), true);
  assert.equal(nativeLowConfidence(weak, query, { mode: "lexical", score: 0.45 }), true, "no term overlap and weak");
  assert.equal(nativeLowConfidence(weak, query, { mode: "lexical", score: 0.35 }), false, "both signals must agree");
  const onTopic = [{ text: "Piano warranty card scanned", path: "memory/house.md", score: 0.4 }];
  assert.equal(nativeLowConfidence(onTopic, query, { mode: "lexical", score: 0.45 }), false, "lexical evidence clears the flag");
  assert.equal(nativeLowConfidence(onTopic, query, { mode: "score", score: 0.45 }), true);
  assert.equal(nativeLowConfidence([{ text: "Rechnungen 2025", score: 0.3 }], "Rechnung Flügel", { mode: "lexical" }), false, "five-character stems tolerate inflection");
  assert.equal(lacksLexicalEvidence(weak, "what is it"), false, "no content terms, no flag");
  assert.equal(lacksLexicalEvidence([], query), false);
  assert.equal(lacksLexicalEvidence([{ path: "memory/piano.md" }], query), false, "paths count as evidence");
  assert.equal(lacksLexicalEvidence([{}], query), true);
  assert.deepEqual(queryTerms("What did we decide about the Kita Anmeldung? kita"), ["decide", "kita", "anmeldung"]);
  assert.deepEqual(queryTerms(undefined), []);

  const { host } = fakeHost({ hits: [hit("memory/trip.md", 0.4)] });
  const search = createNativeSearch({}, { loadHost: async () => host });
  assert.equal((await search(query, { ctx })).lowConfidence, false);
  assert.equal((await search(query, { ctx, lowConfidenceMode: "lexical", lowConfidenceScore: 0.45 })).lowConfidence, true);
});

test("applySourceQuota keeps 3 notes + 2 session chunks, fills free slots and orders by score", () => {
  const m = (n, score) => ({ text: `m${n}`, score });
  const sess = (n, score) => ({ text: `s${n}`, score });
  const memory = [m(1, 0.5), m(2, 0.45), m(3, 0.44), m(4, 0.43)];
  const sessions = [sess(1, 0.7), sess(2, 0.69), sess(3, 0.68), sess(4, 0.67)];
  const quota = { memory: 3, sessions: 2 };
  assert.deepEqual(applySourceQuota(memory, sessions, quota, 5).map((x) => x.text), ["s1", "s2", "m1", "m2", "m3"]);
  assert.deepEqual(applySourceQuota(memory, sessions, quota, 7).map((x) => x.text), ["s1", "s2", "s3", "s4", "m1", "m2", "m3"], "free slots filled by score");
  assert.deepEqual(applySourceQuota(memory, undefined, quota, 5).map((x) => x.text), ["m1", "m2", "m3", "m4"], "missing sessions leave room for notes");
  assert.deepEqual(applySourceQuota(undefined, sessions.slice(0, 1), quota, 5).map((x) => x.text), ["s1"]);
  assert.deepEqual(applySourceQuota(memory, sessions, quota, 2).map((x) => x.text), ["s1", "s2"]);
  assert.deepEqual(applySourceQuota([{ text: "a" }, m(2, 0.1)], [], { memory: 2, sessions: 0 }, 5).map((x) => x.text), ["m2", "a"], "unscored sorts last");
});

test("searchNative splits memory and sessions per source when a quota is set", async () => {
  const sessionHit = (n, score) => hit(`sessions/s${n}.jsonl`, score, "sessions");
  const { host, calls } = fakeHost({
    searchImpl: (request) => ({
      hits: request.sources[0] === "sessions"
        ? [sessionHit(1, 0.7), sessionHit(2, 0.69), sessionHit(3, 0.68)]
        : [hit("memory/a.md", 0.5), hit("memory/b.md", 0.45), hit("memory/c.md", 0.44), hit("memory/d.md", 0.43)],
      coverage: request.sources[0] === "sessions" ? "partial" : "complete",
    }),
  });
  const search = createNativeSearch({}, { loadHost: async () => host });
  const quoted = await search("q", { ctx, sources: ["memory", "sessions"], sourceQuota: { memory: 3, sessions: 2 }, maxResults: 5 });
  assert.deepEqual(calls.search.map((r) => r.sources), [["memory"], ["sessions"]]);
  assert.deepEqual(quoted.results.map((r) => r.path), ["sessions/s1.jsonl", "sessions/s2.jsonl", "memory/a.md", "memory/b.md", "memory/c.md"]);
  assert.deepEqual(quoted.warnings, ["native: index coverage partial"]);
  calls.search.length = 0;
  await search("q", { ctx, sources: ["memory", "sessions"] });
  assert.deepEqual(calls.search.map((r) => r.sources), [["memory", "sessions"]], "no quota: one mixed search");
  calls.search.length = 0;
  await search("q", { ctx, sources: ["memory"], sourceQuota: { memory: 3, sessions: 2 } });
  assert.deepEqual(calls.search.map((r) => r.sources), [["memory"]], "one source: no split");
});
