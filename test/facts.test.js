import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createFacts, renderCurrentState, UNAVAILABLE } from "../src/facts.js";
import plugin from "../index.js";

const value = { action: "add", subject: "person:owner", predicate: "pref.language", value: "English", value_type: "string", unit: null, valid_from: null, privacy_class: "shareable" };
const owner = { sessionKey: "agent:main:dashboard:ae7a4c2c-7c41-447c-8796-d3c656c08127", sessionId: "incarnation", senderIsOwner: true, requesterSenderId: "owner", requesterProfileId: "profile", messageChannel: "webchat", memoryAudience: { kind: "owner-private" }, assertMemoryAudienceCurrent() {} };
const config = { endpoint: "http://memory.test", facts: { enabled: true } };
const response = (body) => ({ ok: true, json: async () => body });
const text = (result) => result.content[0].text;
let serial = 0;
function harness(options = {}) {
  const hooks = {}, tools = {}, calls = [], logs = [];
  const ctx = { ...owner, ...options.ctx };
  globalThis.__factsTestCredential = "synthetic-test-only";
  const api = { pluginConfig: { ...config, ...options.config }, logger: { debug(message) { logs.push(message); }, warn(message) { logs.push(message); } },
    on(name, fn) { hooks[name] = fn; },
    registerTool(factory, meta) {
      const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url)));
      assert.ok(manifest.contracts.tools.includes(meta.name));
      tools[meta.name] = factory(ctx);
    } };
  const facts = options.plugin ? (plugin.register(api), undefined) : createFacts(api, api.pluginConfig);
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init.body && JSON.parse(init.body);
    calls.push({ url, init, body });
    if (options.fetch) return options.fetch(url, init, body, calls.length);
    if (url.includes("/facts/drafts")) return response({ ...body, draft_id: "d_" + ++serial, expires_at: new Date(Date.now() + 86400000).toISOString(), ...options.draft });
    if (url.includes("/facts/confirm")) return response({ draft_id: body.draft_id, action: options.action ?? "add" });
    if (url.includes("/facts/current")) return response(options.current ?? { state: "not_found" });
    return response(options.search ?? { results: [], current_state: [{ state: "not_found" }] });
  };
  const propose = (params = value) => tools.memory_fact_propose.execute("call", params);
  const confirm = (draft_id) => tools.memory_fact_confirm.execute("confirm", { draft_id });
  const ready = async (params) => { const result = text(await propose(params)); assert.match(result, /Save this private fact/); return JSON.parse(result.slice(result.indexOf("{"), result.lastIndexOf("}") + 1)).draft_id; };
  return { ctx, hooks, tools, calls, facts, logs, propose, confirm, ready, close() { globalThis.fetch = previous; delete globalThis.__factsTestCredential; } };
}

test("capture off by default and global disable", async () => {
  for (const cfg of [{}, { facts: { enabled: false } }, { enabled: false, facts: { enabled: true } }]) {
    const h = harness({ config: { facts: undefined, ...cfg } });
    try { assert.equal(h.tools.memory_fact_propose, undefined); assert.equal(h.tools.memory_fact_confirm, undefined); assert.match(text(await h.facts.recall(owner, {})), /unavailable/); } finally { h.close(); }
  }
});

test("proposal never saves; explicit id confirmation saves once without inbound hooks", async () => {
  const h = harness();
  try {
    assert.equal(h.hooks.inbound_claim, undefined); assert.equal(h.hooks.message_sent, undefined);
    const id = await h.ready(); assert.equal(h.calls.length, 1);
    assert.match(text(await h.confirm(id)), /committed: add/);
    assert.match(text(await h.confirm(id)), /unavailable/);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[0].body.origin.audience, "owner_private");
    assert.equal(h.calls[1].body.confirmation.by, "owner");
    assert.equal(h.calls[0].init.redirect, "error");
    assert.equal(h.calls[0].init.headers.authorization, "Bearer synthetic-test-only");
  } finally { h.close(); }
});

test("all host gates deny proposal and confirmation, even inherited owner-private authority", async () => {
  for (const bad of [
    { senderIsOwner: false }, { senderIsOwner: undefined }, { memoryAudience: null }, { memoryAudience: {} }, { memoryAudience: { kind: "conversation" } },
    { sessionKey: undefined }, { sessionKey: "agent:main:subagent:child" }, { sessionKey: "agent:main:cron:job" },
    { sessionKey: "agent:main:heartbeat" }, { sessionKey: "cron:job" }, { sessionKey: "agent:main:hook:direct:id" }, { sessionKey: "agent:main:dashboard:not-a-uuid" }, { sessionKey: "agent:main:telegram:default:direct:id" }, { sessionKey: "agent:main:direct:owner" }, { sessionKey: "agent:main:inter-session:source" }, { sessionKey: "agent:main:telegram:group:123" },
    { sessionId: undefined }, { sessionId: "" },
    { chatType: "group" }, { chatType: "channel" }, { assertMemoryAudienceCurrent: undefined },
    { trigger: "cron" }, { trigger: "heartbeat" }, { runKind: "inter_session" }, { runType: "subagent" },
    { inputProvenance: null }, { inputProvenance: { kind: "inter_session" } },
    { inputProvenance: { kind: "internal_system" } }, { inputProvenance: { kind: "external_user", sourceRole: "subagent" } },
    { oneShotCliRun: true }, { memoryFlush: {} },
    ...["forward_origin", "forwarded", "ForwardedFrom", "ForwardedFromType", "ForwardedFromId", "ForwardedDate", "ForwardedFromUsername", "ForwardedFromTitle", "ForwardedFromSignature", "ForwardedFromChatType", "ForwardedFromMessageId", "ReplyToForwardedFrom"].map((key) => ({ [key]: "present" })),
    { messageProvenance: "forwarded" },
    { assertMemoryAudienceCurrent() { this.senderIsOwner = false; } }, { assertInvocationCurrent() { throw Error("revoked"); } }, { assertMemoryAudienceCurrent() { throw Error("revoked"); } },
  ]) {
    const h = harness();
    try {
      const id = await h.ready(); Object.assign(h.ctx, bad);
      assert.match(text(await h.confirm(id)), /unavailable/);
      assert.match(text(await h.propose()), /unavailable/); assert.equal(h.calls.length, 1);
    } finally { h.close(); }
  }
  // Owner/private root authority alone cannot authorize automated continuations.
  for (const kind of ["cron", "heartbeat", "inter_session"]) {
    const h = harness({ ctx: { sessionKey: "agent:main:main", requesterProfileId: undefined, trigger: kind } });
    try { assert.match(text(await h.propose()), /unavailable/); assert.equal(h.calls.length, 0); } finally { h.close(); }
  }
});

test("sender-bearing owner-private root contexts allow any channel without profile or run provenance", async () => {
  for (const [messageChannel, sessionKey] of [
    ["webchat", owner.sessionKey], ["telegram", "agent:main:telegram:direct:123"],
    ["webchat", "agent:main:main"], ["discord", "agent:main:discord:direct:123"],
  ]) {
    const h = harness({ ctx: { messageChannel, sessionKey, requesterProfileId: undefined, forwarded: undefined } });
    try { const id = await h.ready(); h.ctx.requesterProfileId = "optional-metadata"; assert.match(text(await h.confirm(id)), /committed/); } finally { h.close(); }
  }
  const h = harness({ ctx: { chatType: "direct", trigger: "user", runKind: "user", runType: "user", inputProvenance: { kind: "external_user" } } });
  try { await h.ready(); } finally { h.close(); }
});

test("owner direct fallback accepts Telegram, dashboard without sender, and main sessions", async () => {
  for (const sessionKey of ["agent:main:telegram:direct:123", owner.sessionKey, "agent:main:main"]) {
    for (const requesterSenderId of [undefined, "", "owner"]) {
      for (const requesterProfileId of [undefined, "", "verified-profile"]) {
        const h = harness({ ctx: { sessionKey, requesterSenderId, requesterProfileId, memoryAudience: undefined, assertMemoryAudienceCurrent: undefined } });
        try { const id = await h.ready(); assert.match(text(await h.confirm(id)), /committed/); assert.equal(h.calls.length, 2); } finally { h.close(); }
      }
    }
  }
});

test("fallback denies non-owner, forwarded, non-private audience, and non-private root keys", async () => {
  for (const bad of [
    { senderIsOwner: false }, { senderIsOwner: undefined }, { memoryAudience: { kind: "conversation" } },
    { memoryAudience: { kind: "unknown" } }, { messageProvenance: "forwarded" }, { forwarded: false },
    ...["telegram:group:123", "telegram:channel:123", "subagent:child", "cron:job", "hook:direct:id", "inter-session:source", "inter-session:direct:source", "inter_session:direct:source", "unknown", "unknown:channel:id"].map((key) => ({ sessionKey: "agent:main:" + key })),
  ]) {
    const h = harness({ ctx: { memoryAudience: undefined, assertMemoryAudienceCurrent: undefined } });
    try {
      const id = await h.ready(); Object.assign(h.ctx, bad);
      assert.match(text(await h.propose()), /unavailable/); assert.match(text(await h.confirm(id)), /unavailable/);
      assert.equal(h.calls.length, 1);
    } finally { h.close(); }
  }
});

test("unknown channel sentinel denies proposal and confirmation with or without audience", async () => {
  for (const audience of [undefined, { kind: "owner-private" }]) {
    const h = harness({ ctx: { memoryAudience: audience } });
    try {
      const id = await h.ready();
      h.ctx.sessionKey = "agent:main:unknown:direct:peer";
      assert.match(text(await h.propose()), /unavailable/);
      assert.match(text(await h.confirm(id)), /unavailable/);
      assert.equal(h.calls.length, 1);
    } finally { h.close(); }
  }
});

test("draft identity binding uses sender then profile then session, without downgrade", async () => {
  for (const initial of [
    { requesterSenderId: undefined, requesterProfileId: "profile" },
    { requesterSenderId: undefined, requesterProfileId: undefined },
    { requesterSenderId: "owner", requesterProfileId: "profile" },
  ]) {
    for (const changed of [{ requesterSenderId: "new-sender" }, { requesterSenderId: undefined, requesterProfileId: "new-profile" }, { requesterSenderId: undefined, requesterProfileId: undefined }]) {
      const h = harness({ ctx: initial });
      try {
        const id = await h.ready(); Object.assign(h.ctx, changed);
        const unchanged = !initial.requesterSenderId && !initial.requesterProfileId && !changed.requesterSenderId && !changed.requesterProfileId;
        assert.match(text(await h.confirm(id)), unchanged ? /committed/ : /unavailable/);
        assert.equal(h.calls.length, unchanged ? 2 : 1);
      } finally { h.close(); }
    }
  }
});

test("Telegram group audience and nonowner deny both tools", async () => {
  for (const bad of [{ sessionKey: "agent:main:telegram:group:123" }, { senderIsOwner: false }, { memoryAudience: { kind: "conversation" } }]) {
    const h = harness({ ctx: { messageChannel: "telegram", sessionKey: "agent:main:telegram:direct:123", requesterProfileId: undefined } });
    try {
      const id = await h.ready(); Object.assign(h.ctx, bad);
      assert.match(text(await h.propose()), /unavailable/); assert.match(text(await h.confirm(id)), /unavailable/);
      assert.equal(h.calls.length, 1);
    } finally { h.close(); }
  }
});

test("audience currency is checked immediately before every backend call and after awaits", async () => {
  let checks = 0;
  const h = harness({ ctx: { assertMemoryAudienceCurrent() { checks++; } }, fetch(_url, _init, body) {
    assert.ok(checks >= 2); checks = 0;
    return response({ ...body, draft_id: "currency", expires_at: new Date(Date.now() + 60000).toISOString() });
  } });
  try { await h.ready(); assert.ok(checks >= 2); } finally { h.close(); }
  const revoked = harness({ fetch(_url, _init, body) {
    revoked.ctx.assertMemoryAudienceCurrent = () => { throw Error("revoked during I/O"); };
    return response({ ...body, draft_id: "revoked", expires_at: new Date(Date.now() + 60000).toISOString() });
  } });
  try { assert.match(text(await revoked.propose()), /unavailable/); } finally { revoked.close(); }
});

test("draft binding rejects foreign sender/session/incarnation and unknown ids", async () => {
  for (const field of ["requesterSenderId", "sessionId", "sessionKey"]) {
    const h = harness();
    try { const id = await h.ready(); h.ctx[field] = field === "sessionKey" ? "agent:main:main" : "foreign"; assert.match(text(await h.confirm(id)), /unavailable/); assert.equal(h.calls.length, 1); } finally { h.close(); }
  }
  const h = harness();
  try { assert.match(text(await h.confirm("foreign-backend-id")), /unavailable/); } finally { h.close(); }
});

test("new proposal and lifecycle resets invalidate previous drafts", async () => {
  for (const hook of ["session_start", "session_end", "before_reset"]) {
    const h = harness();
    try {
      const old = await h.ready(); const id = await h.ready();
      assert.match(text(await h.confirm(old)), /unavailable/);
      h.hooks[hook]({}, h.ctx); assert.match(text(await h.confirm(id)), /unavailable/);
      const next = await h.ready(); h.hooks[hook]({ sessionKey: h.ctx.sessionKey }, {});
      assert.match(text(await h.confirm(next)), /unavailable/);
    } finally { h.close(); }
  }
});

test("fresh TTL is at most five minutes, prune and request-time expiry deny", async () => {
  const original = Date.now;
  const start = original();
  const h = harness();
  try {
    Date.now = () => start; const id = await h.ready();
    Date.now = () => start + 300001;
    assert.match(text(await h.confirm(id)), /unavailable/); assert.equal(h.calls.length, 1);
  } finally { Date.now = original; h.close(); }
  const h2 = harness({ fetch: async (url, init, body) => {
    if (url.includes("drafts")) return response({ ...body, draft_id: "expiring", expires_at: new Date(start + 1000).toISOString() });
    Date.now = () => start + 1001; return response({ draft_id: body.draft_id, action: "add" });
  } });
  try { Date.now = () => start; const id = await h2.ready(); assert.match(text(await h2.confirm(id)), /unavailable/); } finally { Date.now = original; h2.close(); }
});

test("unsafe fields and model origin injection are screened", async () => {
  for (const params of [{ ...value, predicate: "custom.test" }, { ...value, predicate: "body.weight" }, { ...value, value: "my password is unsafe" }, { ...value, value: "a".repeat(8001) }, { ...value, value: "pa\u200bssword" }]) {
    const h = harness(); try { assert.match(text(await h.propose(params)), /unavailable/); assert.equal(h.calls.length, 0); } finally { h.close(); }
  }
  const h = harness(); try { await h.propose({ ...value, origin: { audience: "group" } }); assert.equal(h.calls[0].body.origin.audience, "owner_private"); } finally { h.close(); }
});

test("invalid backend draft mismatches fail closed", async () => {
  for (const draft of [{ action: "end" }, { subject: "person:other" }, { predicate: "pref.timezone" }, { value: "changed" }, { draft_id: 7 }, { draft_id: "" }, { expires_at: "invalid" }, { expires_at: new Date(1).toISOString() }]) {
    const h = harness({ draft }); try { assert.match(text(await h.propose()), /unavailable/); } finally { h.close(); }
  }
});

test("end replace retract forget all require matching draft confirmation and prior target readback", async () => {
  for (const action of ["end", "replace", "retract", "forget"]) {
    const mapped = action === "forget" ? "retract" : action;
    const prior = { fact_id: "old", value: "Old language", privacy_class: "shareable" };
    const h = harness({ action: mapped, draft: { will_supersede: ["old"], target_fact_ids: ["old"] }, current: { current: prior } });
    try {
      const id = await h.ready({ ...value, action, item_key: "key", valid_to: "2026-11-26" });
      assert.equal(h.calls.length, 2); assert.match(h.calls[1].url, /item_key=key/);
      assert.match(text(await h.confirm(id)), /committed/); assert.equal(h.calls[0].body.action, mapped);
    } finally { h.close(); }
  }
  for (const current of [{}, { alternatives: [{ fact_id: "old", value: "prior" }] }, { historical: [{ fact_id: "old", value: "prior" }] }]) {
    const h = harness({ draft: { target_fact_ids: ["old"] }, current });
    try { assert.match(text(await h.propose()), Object.keys(current).length ? /prior/ : /unavailable/); } finally { h.close(); }
  }
});

test("transport secret endpoint HTTP JSON failures redacted, never acknowledge save", async () => {
  for (const failure of ["secret", "endpoint", "protocol", "query", "hash", "invalid", "http", "json", "transport"]) {
    const h = harness({ config: { endpoint: ({ endpoint: "http://user:pass@memory.test", protocol: "ftp://memory.test", query: "http://memory.test?x", hash: "http://memory.test#x", invalid: "invalid" })[failure] ?? "http://memory.test", timeoutMs: 1000 } });
    try {
      if (failure === "secret") delete globalThis.__factsTestCredential;
      if (failure === "http") globalThis.fetch = async () => ({ ok: false });
      if (failure === "json") globalThis.fetch = async () => ({ ok: true, json() { throw Error("PRIVATE FACT"); } });
      if (failure === "transport") globalThis.fetch = async () => { throw Error("PRIVATE FACT"); };
      const result = text(await h.propose()); assert.match(result, /unavailable/); assert.doesNotMatch(result, /PRIVATE FACT|synthetic-test-only/); assert.deepEqual(h.logs, []);
    } finally { h.close(); }
  }
  for (const bad of ["http", "shape"]) {
    const h = harness();
    try { const id = await h.ready(); globalThis.fetch = async () => bad === "http" ? { ok: false } : response({ draft_id: "wrong", action: "wrong" }); assert.match(text(await h.confirm(id)), /unavailable/); assert.match(text(await h.confirm(id)), /unavailable/); } finally { h.close(); }
  }
});

test("in-flight proposal and confirmation cannot survive lifecycle reset", async () => {
  for (const operation of ["proposal", "confirmation"]) {
    let release;
    const h = harness();
    try {
      const id = operation === "confirmation" ? await h.ready() : undefined;
      globalThis.fetch = async (_url, init) => new Promise((resolve) => { release = () => resolve(response(operation === "proposal" ? { ...JSON.parse(init.body), draft_id: "late", expires_at: new Date(Date.now() + 60000).toISOString() } : { draft_id: id, action: "add" })); });
      const work = operation === "proposal" ? h.propose() : h.confirm(id);
      h.hooks.before_reset({}, h.ctx); release();
      assert.match(text(await work), /unavailable/); assert.match(text(await h.confirm("late")), /unavailable/);
    } finally { h.close(); }
  }
});

test("restricted redaction is recursive and current resolver metadata precedes evidence", async () => {
  const block = [{ state: "conflict", current: { value: "English", privacy_class: "personal" }, alternatives: [{ value: "HIDDEN", privacy_class: "restricted" }], disclosures: ["stale", "unreviewed", "mail_only", "unknown_source_date"] }, { derived_privacy_class: "restricted", derived_value: 42, source_fact_ids: ["SECRET-ID"] }, null];
  assert.doesNotMatch(renderCurrentState(block), /HIDDEN|42|SECRET-ID/); assert.match(renderCurrentState(block, true), /HIDDEN/);
  assert.equal(renderCurrentState(undefined), UNAVAILABLE); assert.equal(renderCurrentState([]), UNAVAILABLE);
  const h = harness({ search: { results: [{ text: "old evidence" }], current_state: block } });
  try {
    const result = text(await h.facts.recall(h.ctx, { query: "language", fact_subject: "person:owner", fact_predicate: "pref.language", scope: "main", maxResults: 2, include_restricted: true }));
    assert.match(result, /conflict/); assert.match(result, /mail_only/); assert.doesNotMatch(result, /HIDDEN|SECRET-ID/);
    assert.ok(result.indexOf("Current facts") < result.indexOf("old evidence")); assert.match(h.calls[0].url, /fact_subject=person%3Aowner/);
  } finally { h.close(); }
});

test("unavailable is not absence, owner-private reads recheck currency", async () => {
  for (const payload of [{ results: [] }, { current_state: [] }, { current_state: [{ state: "unavailable" }] }, { current_state: [{ state: "not_found" }] }]) {
    const h = harness({ search: payload });
    try { assert.match(text(await h.facts.recall(h.ctx, { query: "x", fact_subject: "person:owner", fact_predicate: "pref.language" })), payload.current_state?.[0]?.state === "not_found" ? /not_found/ : /unavailable/); } finally { h.close(); }
  }
  for (const ctx of [{ memoryAudience: undefined }, { messageProvenance: "forwarded" }, { assertMemoryAudienceCurrent() { throw Error("revoked"); } }]) {
    const h = harness(); try { assert.match(text(await h.facts.recall({ ...h.ctx, ...ctx }, {})), /unavailable/); assert.equal(h.calls.length, 0); } finally { h.close(); }
  }
});

test("feature on renders current facts automatically in unified search and auto-recall with redacted logs", async () => {
  const h = harness({ plugin: true, current: { state: "resolved", current: { value: "PRIVATE FACT" } }, search: { results: [], current_state: [{ current: { value: "PRIVATE FACT", privacy_class: "personal" } }] } });
  try {
    assert.match(text(await h.tools.unified_memory_search.execute("call", { query: "language" })), /PRIVATE FACT/);
    assert.match(h.calls[0].url, /fact_subject=person%3Aowner&fact_predicate=pref.language/);
    globalThis.fetch = async (url) => response(url.includes("/facts/current") ? { state: "resolved", current: { value: "PRIVATE FACT" } } : { results: [] });
    const result = await h.hooks.before_prompt_build({ prompt: "language?" }, { ...h.ctx, trigger: "user" });
    assert.match(result.prependContext, /PRIVATE FACT/); assert.deepEqual(h.logs, []);
    delete globalThis.__factsTestCredential;
    assert.match((await h.hooks.before_prompt_build({ prompt: "language?" }, { ...h.ctx, trigger: "user" })).prependContext, /unavailable/);
  } finally { h.close(); }
});

test("automatic current slice uses concrete backend slots; malformed or failed lane is unavailable", async () => {
  for (const failure of ["shape", "transport"]) {
    const h = harness({ current: {} });
    try {
      if (failure === "transport") globalThis.fetch = async () => { throw Error("PRIVATE FACT"); };
      assert.equal(await h.facts.current(h.ctx), UNAVAILABLE);
      assert.deepEqual(h.logs, []);
    } finally { h.close(); }
  }
  const h = harness();
  try {
    await h.facts.current(h.ctx);
    assert.equal(h.calls.length, 18);
    assert.ok(h.calls.some(({ url }) => url.includes("predicate=person.age_stated")));
    assert.equal(h.calls.every(({ url }) => url.includes("subject=person%3Aowner") && url.includes("predicate=")), true);
  } finally { h.close(); }
});


test("automatic facts overlap evidence and stay inside the registered hook deadline", async () => {
  // Each HTTP phase fits its timeout, but three sequential phases exceed the hook.
  for (const evidenceFails of [false, true]) {
    const h = harness({ plugin: true });
    try {
      let deadline;
      plugin.register({ pluginConfig: config, on(name, _fn, options) { if (name === "before_prompt_build") deadline = options.timeoutMs; }, registerTool() {} });
      let searches = 0;
      globalThis.fetch = async (url) => {
        await new Promise((resolve) => setTimeout(resolve, 1150));
        if (url.includes("/facts/current")) return response({ state: "resolved", current: { value: "PRIVATE FACT" } });
        searches++;
        if (evidenceFails) throw Error("synthetic failure");
        return response({ results: [] });
      };
      const started = Date.now();
      const result = await h.hooks.before_prompt_build({ prompt: "What about Acme GmbH?" }, h.ctx);
      assert.ok(Date.now() - started < deadline, "facts must not consume a third sequential phase");
      assert.equal(searches, evidenceFails ? 1 : 2);
      assert.match(result.prependContext, /PRIVATE FACT/);
      if (evidenceFails) assert.match(result.prependContext, /retrieval unavailable/);
    } finally { h.close(); }
  }
});
