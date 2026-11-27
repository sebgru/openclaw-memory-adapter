import test from "node:test";
import assert from "node:assert/strict";
import { createFacts, UNAVAILABLE } from "../src/facts.js";

const owner = { senderIsOwner: true, sessionKey: "agent:main:main", sessionId: "synthetic-session",
  memoryAudience: { kind: "owner-private" }, assertMemoryAudienceCurrent() {} };
const payload = { action: "add", subject: "person:owner", predicate: "pref.language", value: "English",
  value_type: "string", unit: null, valid_from: null, privacy_class: "shareable" };
const response = (data) => ({ ok: true, json: async () => data });
const resultText = (result) => result.content[0].text;
function harness(options = {}) {
  const tools = {}, logs = [], ctx = { ...owner, ...options.ctx };
  const previousFetch = globalThis.fetch;
  globalThis.__factsTestCredential = "synthetic-private-credential";
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    if (options.fetch) return options.fetch(url, init);
    const body = init.body && JSON.parse(init.body);
    if (url.includes("/drafts")) return response({ ...body, draft_id: "synthetic-draft", expires_at: new Date(Date.now() + 300000).toISOString() });
    if (url.includes("/confirm")) return response({ draft_id: body.draft_id, action: "add" });
    if (url.includes("/unified")) return response({ results: [], current_state: [{ state: "not_found" }] });
    return response({ state: "not_found" });
  };
  const facts = createFacts({ logger: options.logger ?? { warn: (line) => logs.push(line) }, on() {},
    registerTool(factory, meta) { tools[meta.name] = factory(ctx); } },
  { endpoint: "http://synthetic.test", facts: { enabled: true }, ...options.config });
  return { facts, ctx, logs, calls: () => calls,
    propose: (params = payload) => tools.memory_fact_propose.execute("call", params),
    confirm: (id = "synthetic-draft") => tools.memory_fact_confirm.execute("call", { draft_id: id }),
    close() { globalThis.fetch = previousFetch; delete globalThis.__factsTestCredential; } };
}
function logged(h, stage, reason, count = 1) {
  assert.equal(h.logs.length, count);
  assert.ok(h.logs.some((line) => line.startsWith(`memory-adapter: facts unavailable stage=${stage} reason=${reason} hints=`)), h.logs.join("\n"));
  for (const line of h.logs) {
    const hints = JSON.parse(line.split(" hints=")[1]);
    assert.equal(Object.keys(hints).length, 14);
    assert.ok(Object.values(hints).every((value) => typeof value === "boolean"));
  }
}

const denials = [
  ["OWNER_FLAG_MISSING", { senderIsOwner: undefined }], ["OWNER_FALSE", { senderIsOwner: false }],
  ["AUDIENCE_KIND", { memoryAudience: { kind: "conversation" } }],
  ["AUDIENCE_STALE", { assertMemoryAudienceCurrent: undefined }],
  ["AUDIENCE_STALE", { assertMemoryAudienceCurrent() { throw new Error("private audience details"); } }],
  ["TRIGGER_KIND", { trigger: "cron" }], ["TRIGGER_KIND", { runKind: "inter_session" }], ["TRIGGER_KIND", { runType: "subagent" }],
  ["CHAT_TYPE", { chatType: "group" }], ["PROVENANCE", { inputProvenance: { kind: "internal" } }],
  ["PROVENANCE", { inputProvenance: { kind: "external_user", sourceRole: "assistant" } }],
  ["ONE_SHOT", { oneShotCliRun: true }], ["MEMORY_FLUSH", { memoryFlush: true }],
  ["SESSION_SHAPE", { sessionKey: "agent:main:subagent:synthetic" }], ["SESSION_SHAPE", { sessionId: "" }],
  ["FORWARDED", { messageProvenance: "forwarded" }], ["FORWARDED", { forward_origin: "synthetic-origin" }],
  ["FORWARDED", { forwarded: false }], ["FORWARDED", { ForwardedFrom: "synthetic-sender" }],
  ["FORWARDED", { ReplyToForwardedFrom: "synthetic-sender" }],
  ["INVOCATION_STALE", { assertInvocationCurrent() { throw new Error("private invocation details"); } }],
];
for (const [index, [reason, ctx]] of denials.entries()) {
  test(`guard reason ${reason} variant ${index} in all four stages`, async () => {
    const h = harness({ ctx });
    try {
      assert.equal(await h.facts.current(h.ctx), UNAVAILABLE);
      assert.equal(resultText(await h.facts.recall(h.ctx, { query: "synthetic-query" })), UNAVAILABLE);
      assert.equal(resultText(await h.propose()), UNAVAILABLE + " No draft is confirmable from this failed proposal.");
      assert.equal(resultText(await h.confirm()), UNAVAILABLE + " Do not retry this confirmation; propose a new draft.");
      for (const stage of ["hook-current", "tool-recall", "propose", "confirm"]) logged(h, stage, reason, 4);
      assert.equal(h.calls(), 0);
      assert.equal(h.facts.revalidateCurrent(h.ctx, "private notice"), UNAVAILABLE);
      assert.equal(h.logs.length, 4); // revalidation shares the hook stage dedupe key
    } finally { h.close(); }
  });
}

test("disabled facts have an explicit reason and no request", async () => {
  const h = harness({ config: { enabled: false } });
  try { assert.equal(await h.facts.current(h.ctx), UNAVAILABLE); logged(h, "hook-current", "DISABLED"); assert.equal(h.calls(), 0); }
  finally { h.close(); }
});

const requestFailures = [
  ["SECRET_UNPREPARED", { prepare() { delete globalThis.__factsTestCredential; } }],
  ["SECRET_UNPREPARED", { prepare() { Object.defineProperty(globalThis, "__factsTestCredential", { configurable: true, get() { throw new Error("private secret resolver details"); } }); } }],
  ...["not a URL", "file:///private", "http://user:password@synthetic.test", "http://synthetic.test/?private-query", "http://synthetic.test/#private-fragment"].map((endpoint) => ["INVALID_ENDPOINT", { config: { endpoint } }]),
  ...[401, 403, 429, 500, 503].map((status) => [`HTTP_${status}`, { fetch: async () => ({ ok: false, status }) }]),
  ["UNKNOWN", { fetch: async () => ({ ok: false, status: "private-response-value" }) }],
  ...["TimeoutError", "AbortError"].map((name) => ["TIMEOUT", { fetch: async () => { throw Object.assign(new Error("private transport details"), { name }); } }]),
  ["TIMEOUT", { fetch: async () => ({ ok: true, json: async () => { throw new DOMException("private body details", "AbortError"); } }) }],
  ["RESPONSE_SHAPE", { fetch: async () => ({ ok: true, json: async () => { throw new SyntaxError("private response body"); } }) }],
  ["STATE_SHAPE", { fetch: async () => response({}) }],
  ["UNKNOWN", { fetch: async () => { throw new Error("private arbitrary failure"); } }],
];
for (const [index, [reason, options]] of requestFailures.entries()) {
  test(`request reason ${reason} variant ${index}`, async () => {
    const h = harness(options);
    try { options.prepare?.(); assert.equal(await h.facts.current(h.ctx), UNAVAILABLE); logged(h, "hook-current", reason); }
    finally { h.close(); }
  });
}

test("request rechecks invocation and audience currency after response", async () => {
  for (const [field, reason] of [["assertInvocationCurrent", "INVOCATION_STALE"], ["assertMemoryAudienceCurrent", "AUDIENCE_STALE"]]) {
    const h = harness({ fetch: async () => {
      h.ctx[field] = () => { throw new Error("private stale details"); };
      return response({ state: "not_found" });
    } });
    try { assert.equal(await h.facts.current(h.ctx), UNAVAILABLE); logged(h, "hook-current", reason); }
    finally { h.close(); }
  }
});

test("second authorization check diagnoses audience mutation", async () => {
  const h = harness();
  h.ctx.assertMemoryAudienceCurrent = () => { h.ctx.senderIsOwner = false; };
  try { assert.equal(await h.facts.current(h.ctx), UNAVAILABLE); logged(h, "hook-current", "OWNER_FALSE"); assert.equal(h.calls(), 0); }
  finally { h.close(); }
});

test("recall logs request failures, malformed explicit state and implicit current failures at tool stage", async () => {
  for (const mode of ["http", "explicit", "implicit"]) {
    const h = harness({ fetch: async (url) => mode === "http" ? { ok: false, status: 503 } :
      response(url.includes("/unified") ? { results: [] } : {}) });
    try {
      const text = resultText(await h.facts.recall(h.ctx, { query: "private query", ...(mode === "explicit" ? { fact_subject: "person:owner" } : {}) }));
      assert.ok(text.startsWith(UNAVAILABLE));
      logged(h, "tool-recall", mode === "http" ? "HTTP_503" : "STATE_SHAPE");
    } finally { h.close(); }
  }
});

test("proposal and confirmation response validation, unknown errors, and consumed confirmations stay fail-closed", async () => {
  for (const stage of ["propose", "confirm"]) {
    const h = harness();
    try {
      if (stage === "confirm") assert.match(resultText(await h.propose()), /Save this private fact change/);
      globalThis.fetch = async () => response({ private: "never logged" });
      assert.ok(resultText(await h[stage]()).startsWith(UNAVAILABLE));
      logged(h, stage, "RESPONSE_SHAPE");
      if (stage === "confirm") {
        assert.ok(resultText(await h.confirm()).startsWith(UNAVAILABLE));
        logged(h, "confirm", "UNKNOWN", 2);
      }
    } finally { h.close(); }
  }
  const h = harness();
  try { assert.ok(resultText(await h.propose({ ...payload, value: "password: synthetic" })).startsWith(UNAVAILABLE)); logged(h, "propose", "UNKNOWN"); }
  finally { h.close(); }
});

test("successful reads, proposal and confirmation produce no diagnostics", async () => {
  const h = harness();
  try {
    assert.match(await h.facts.current(h.ctx), /^Current facts \(/);
    assert.match(resultText(await h.facts.recall(h.ctx, { query: "test", fact_subject: "person:owner" })), /^Current facts \(/);
    assert.match(resultText(await h.propose()), /Save this private fact change/);
    assert.match(resultText(await h.confirm()), /committed: add/);
    assert.equal(h.facts.revalidateCurrent(h.ctx, "notice"), "notice");
    assert.deepEqual(h.logs, []);
  } finally { h.close(); }
});

test("diagnostics contain only static codes, stages and boolean hints, never private values", async () => {
  const privateValues = ["synthetic-private-credential", "synthetic-sender-id", "synthetic-profile-id", "synthetic-private-session", "synthetic-private-query", "synthetic-private-fact", "synthetic-private-prompt", "synthetic-private-response"];
  const h = harness({ ctx: { sessionId: privateValues[3], requesterSenderId: privateValues[1], requesterProfileId: privateValues[2], prompt: privateValues[6] },
    fetch: async (url, init) => { throw new Error(`${privateValues.join(" ")} ${url} ${init.headers.authorization} ${init.body}`); } });
  try {
    await h.facts.current(h.ctx);
    await h.facts.recall(h.ctx, { query: privateValues[4], fact_subject: "person:owner" });
    await h.propose({ ...payload, value: privateValues[5] });
    await h.confirm();
    const output = h.logs.join("\n");
    for (const value of privateValues) assert.ok(!output.includes(value));
    assert.ok(!output.includes("http")); assert.ok(!output.includes("Bearer"));
    assert.ok(!output.includes("person:owner")); assert.ok(!output.includes("agent:main:main"));
    for (const stage of ["hook-current", "tool-recall", "propose", "confirm"]) logged(h, stage, "UNKNOWN", 4);
  } finally { h.close(); }
});

test("dedupe expires after a minute, separates sessions and caps retention", async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const h = harness({ ctx: { senderIsOwner: undefined } });
  try {
    await h.facts.current(h.ctx); await h.facts.current(h.ctx); assert.equal(h.logs.length, 1);
    now += 60000; await h.facts.current(h.ctx); assert.equal(h.logs.length, 2);
    for (let i = 0; i < 256; i++) { h.ctx.sessionId = `synthetic-session-${i}`; await h.facts.current(h.ctx); }
    h.ctx.sessionId = owner.sessionId; await h.facts.current(h.ctx);
    assert.equal(h.logs.length, 259);
  } finally { Date.now = originalNow; h.close(); }
});

test("missing or throwing loggers cannot change fail-closed replies", async () => {
  for (const logger of [{}, { warn() { throw new Error("private logger failure"); } }]) {
    const h = harness({ ctx: { senderIsOwner: undefined }, logger });
    try { assert.equal(await h.facts.current(h.ctx), UNAVAILABLE); assert.equal(resultText(await h.propose()), UNAVAILABLE + " No draft is confirmable from this failed proposal."); }
    finally { h.close(); }
  }
});

test("public current cannot inject a stage or other values through extra arguments", async () => {
  const h = harness({ ctx: { senderIsOwner: undefined } });
  try {
    assert.equal(await h.facts.current(h.ctx, "synthetic-private-stage"), UNAVAILABLE);
    logged(h, "hook-current", "OWNER_FLAG_MISSING");
    assert.ok(!h.logs.join("").includes("synthetic-private-stage"));
  } finally { h.close(); }
});
