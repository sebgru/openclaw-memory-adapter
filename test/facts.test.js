import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createFacts, renderCurrentState, UNAVAILABLE } from "../src/facts.js";
import plugin from "../index.js";

const value = { action: "add", subject: "person:owner", predicate: "pref.language", value: "English", value_type: "string", unit: null, valid_from: null, privacy_class: "shareable" };
const ctx = { sessionKey: "private", sessionId: "incarnation", senderIsOwner: true, requesterSenderId: "owner", memoryAudience: { kind: "owner-private" } };
const config = { endpoint: "http://memory.test", facts: { enabled: true } };
let serial = 0;
function harness(options = {}) {
  const hooks = {}, tools = {}, calls = [];
  globalThis.__factsTestCredential = "synthetic-test-only";
  const api = { pluginConfig: { ...config, ...options.config }, logger: { debug() {}, warn() {} },
    on(name, fn) { hooks[name] = fn; },
    registerTool(factory, meta) {
      const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url)));
      assert.ok(manifest.contracts.tools.includes(meta.name), "native registrar requires manifest tool declaration");
      tools[meta.name] = factory(options.ctx ?? ctx);
    } };
  const facts = options.plugin ? (plugin.register(api), undefined) : createFacts(api, api.pluginConfig);
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init.body && JSON.parse(init.body);
    calls.push({ url, init, body });
    if (options.fetch) return options.fetch(url, init, body, calls.length);
    if (url.includes("/facts/drafts")) return response({ ...body, draft_id: "d_" + ++serial, expires_at: new Date(Date.now() + 86400000).toISOString(), will_supersede: [], ...options.draft });
    if (url.includes("/facts/confirm")) return response({ draft_id: body.draft_id, action: options.action ?? "add" });
    if (url.includes("/facts/current")) return response(options.current ?? {});
    return response({ results: [], current_state: [{ state: "not_found" }] });
  };
  const inbound = async (content = "remember this: English", changes = {}, context = {}) => {
    const event = { content, senderIsOwner: true, isGroup: false, timestamp: Date.now(), ...changes };
    const actualCtx = { sessionKey: "private", senderId: "owner", messageProvenance: "direct", messageId: "m" + ++serial, ...context };
    await hooks.inbound_claim(event, actualCtx);
    return actualCtx;
  };
  const propose = (params = value) => tools.memory_fact_draft.execute("call", params);
  const display = (text, event = {}, context = {}) => hooks.message_sent({ content: text, success: true, messageId: "shown" + ++serial, ...event }, { sessionKey: "private", ...context });
  const ready = async (params = value) => { await inbound(); const draft = await propose(params); const text = draft.content[0].text; const id = "display" + ++serial; display(text, { messageId: id }); return id; };
  return { hooks, tools, calls, facts, inbound, propose, display, ready, close() { globalThis.fetch = previous; delete globalThis.__factsTestCredential; } };
}
const response = (body) => ({ ok: true, json: async () => body });
const text = (result) => result.content[0].text;

test("fact capture disabled by default, including global disable", async () => {
  for (const cfg of [{}, { facts: { enabled: false } }, { enabled: false, facts: { enabled: true } }]) {
    const h = harness({ config: { facts: undefined, ...cfg } });
    try { assert.equal(h.tools.memory_fact_draft, undefined); assert.match(text(await h.facts.recall(ctx, {})), /unavailable/); } finally { h.close(); }
  }
});

test("fresh owner reply confirms exactly displayed draft once with transport provenance", async () => {
  for (const yes of ["yes", "ja", "да", "ok", "👍"]) {
    const h = harness();
    try {
      const id = await h.ready();
      assert.equal(h.calls.length, 1);
      await h.inbound(yes, {}, { replyToId: id });
      assert.equal(h.calls.length, 2);
      const confirm = h.calls[1].body;
      assert.match(confirm.draft_id, /^d_/); // server ID is opaque
      assert.equal(confirm.confirmation.by, "owner");
      assert.match(confirm.confirmation.session_ref, /^private#m/);
      assert.match(h.facts.takeNotice(ctx), /committed: add/);
      assert.equal(h.facts.takeNotice(ctx), undefined);
      await h.inbound(yes, {}, { replyToId: id });
      assert.equal(h.calls.length, 2);
      assert.equal(h.calls[0].init.redirect, "error");
      assert.equal(h.calls[0].init.headers.authorization.startsWith("Bearer "), true);
    } finally { h.close(); }
  }
});

test("wrong user, group, unknown audience, missing transport and edited/quoted turns never confirm", async () => {
  const cases = [
    [{ senderIsOwner: false }, {}], [{ senderIsOwner: undefined }, {}], [{ isGroup: true }, {}], [{ isGroup: undefined }, {}],
    [{ timestamp: undefined }, {}], [{ providerUpdate: { editedTimestamp: Date.now() } }, {}], [{ replyToIsQuote: true }, {}],
    [{}, { messageProvenance: undefined }], [{}, { messageProvenance: "forwarded" }], [{}, { messageProvenance: "unknown" }],
    [{}, { senderId: "" }], [{}, { messageId: "" }], [{}, { sessionKey: "" }], [{}, { senderId: "other" }],
  ];
  for (const [event, context] of cases) {
    const h = harness();
    try { const id = await h.ready(); await h.inbound("yes", event, { replyToId: id, ...context }); assert.equal(h.calls.length, 1); } finally { h.close(); }
  }
});

test("unrelated, no, replayed, old, future, stale timestamps and missing reply bindings fail closed", async () => {
  for (const item of [
    { content: "ok unrelated" }, { content: "no" }, { content: "edit" }, { replyToId: "elsewhere" }, { replyToId: undefined },
    { timestamp: 1 }, { timestamp: Date.now() + 60000 },
  ]) {
    const h = harness();
    try { const id = await h.ready(); await h.inbound(item.content ?? "yes", { timestamp: item.timestamp ?? Date.now() }, { replyToId: Object.hasOwn(item, "replyToId") ? item.replyToId : id }); assert.equal(h.calls.length, 1); } finally { h.close(); }
  }
});

test("only exact successful unambiguous delivery binds a draft", async () => {
  for (const event of [{ success: false }, { messageId: undefined }, { content: "changed readback" }, { duplicate: true }]) {
    const h = harness();
    try {
      await h.inbound(); const draft = text(await h.propose());
      h.display(draft, event);
      if (event.duplicate) h.display(draft);
      await h.inbound("yes", {}, { replyToId: "shown" + (serial - 1) });
      assert.equal(h.calls.length, 1);
    } finally { h.close(); }
  }
  const h = harness();
  try { h.display("no pending"); } finally { h.close(); }
});

test("tool authority and explicit current owner intent cannot be supplied by model arguments", async () => {
  for (const bad of [
    { senderIsOwner: false }, { memoryAudience: { kind: "conversation" } }, { sessionKey: undefined },
    { sessionId: undefined }, { requesterSenderId: undefined }, { requesterSenderId: "other" },
    { assertInvocationCurrent() { throw Error("revoked"); } }, { assertMemoryAudienceCurrent() { throw Error("revoked"); } },
  ]) {
    const h = harness({ ctx: { ...ctx, ...bad } });
    try { await h.inbound(); assert.match(text(await h.propose()), /unavailable/); assert.equal(h.calls.length, 0); } finally { h.close(); }
  }
  for (const content of ['Quoted: "remember this English"', "hello", "yes", "> remember this: English"]) {
    const h = harness();
    try { await h.inbound(content); assert.match(text(await h.propose()), /unavailable/); assert.equal(h.calls.length, 0); } finally { h.close(); }
  }
  const h = harness();
  try { assert.match(text(await h.propose()), /unavailable/); } finally { h.close(); }
});

test("missing secret, bad endpoint, HTTP/JSON/transport failures never acknowledge saves or leak content", async () => {
  for (const failure of ["secret", "endpoint", "http", "json", "transport"]) {
    const h = harness(failure === "endpoint" ? { config: { endpoint: "http://user:pass@memory.test" } } :
      failure === "http" ? { fetch: async () => ({ ok: false }) } :
      failure === "json" ? { fetch: async () => ({ ok: true, json() { throw Error("private content"); } }) } :
      failure === "transport" ? { fetch: async () => { throw Error("private content"); } } : {});
    try {
      await h.inbound(); if (failure === "secret") delete globalThis.__factsTestCredential;
      const result = text(await h.propose());
      assert.match(result, /unavailable/); assert.doesNotMatch(result, /private content|synthetic-test-only/);
    } finally { h.close(); }
  }
});

test("unsafe, custom, volatile and weight capture blocked; payload-only origin ignored", async () => {
  for (const params of [
    { ...value, predicate: "custom.test" }, { ...value, predicate: "body.weight" },
    { ...value, predicate: "health.glucose_now" }, { ...value, value: "my password is unsafe" },
    { ...value, value: "a".repeat(8001) }, { ...value, value: "pa\u200bssword" },
  ]) {
    const h = harness();
    try { await h.inbound(); assert.match(text(await h.propose(params)), /unavailable/); assert.equal(h.calls.length, 0); } finally { h.close(); }
  }
  const h = harness();
  try {
    await h.inbound(); await h.propose({ ...value, origin: { audience: "group" } });
    assert.equal(h.calls[0].body.origin.audience, "owner_private");
    assert.equal(h.calls[0].body.origin.session_ref.startsWith("private#m"), true);
    assert.match(text(await h.propose()), /unavailable/); // cannot create two pending drafts
  } finally { h.close(); }
});

test("editing requires fresh intent and invalidates the old displayed draft", async () => {
  const h = harness();
  try {
    const old = await h.ready();
    await h.inbound("remember this: German");
    const result = text(await h.propose({ ...value, value: "German" }));
    assert.match(result, /German/); assert.equal(h.calls.length, 2);
    h.display(result, { messageId: "new" });
    await h.inbound("yes", {}, { replyToId: old });
    assert.equal(h.calls.length, 2);
  } finally { h.close(); }
});

test("invalid backend draft shape, expiry and mismatches cannot be displayed/confirmed", async () => {
  for (const draft of [
    { action: "end" }, { subject: "person:other" }, { predicate: "pref.timezone" }, { value: "changed" },
    { draft_id: "" }, { expires_at: "invalid" }, { expires_at: new Date(1).toISOString() },
  ]) {
    const h = harness({ draft });
    try { await h.inbound(); assert.match(text(await h.propose()), /unavailable/); } finally { h.close(); }
  }
});

test("end, replace, retract and forget use drafts and display exact prior values", async () => {
  for (const action of ["end", "replace", "retract", "forget"]) {
    const mapped = action === "forget" ? "retract" : action;
    const prior = { fact_id: "f_old", value: "Old language", privacy_class: "shareable" };
    const h = harness({ action: mapped, draft: { will_supersede: action === "replace" ? ["f_old"] : [], ...(action !== "replace" ? { target_fact_ids: ["f_old"] } : {}) }, current: { historical: [prior] } });
    try {
      await h.inbound(action === "end" ? "end this fact" : action === "replace" ? "correct this fact" : "forget this");
      const draft = text(await h.propose({ ...value, action, item_key: "key", valid_to: "2026-11-26" }));
      assert.match(draft, /"value_type":"string"/); assert.match(draft, /Old language/); assert.match(h.calls[1].url, /item_key=key/);
      h.display(draft, { messageId: "lifecycle" });
      await h.inbound("yes", {}, { replyToId: "lifecycle" });
      assert.equal(h.calls[2].url.endsWith("/facts/confirm"), true);
      assert.equal(h.calls[0].body.action, mapped);
      assert.match(h.facts.takeNotice(ctx), /committed/);
    } finally { h.close(); }
  }
});

test("lifecycle mismatch and missing exact target readback fail closed", async () => {
  for (const [intent, action] of [["forget this", "add"], ["remember this", "retract"], ["end this fact", "add"]]) {
    const h = harness();
    try { await h.inbound(intent); assert.match(text(await h.propose({ ...value, action })), /unavailable/); assert.equal(h.calls.length, 0); } finally { h.close(); }
  }
  const h = harness({ draft: { target_fact_ids: ["missing"] } });
  try { await h.inbound(); assert.match(text(await h.propose()), /unavailable/); } finally { h.close(); }
});

test("confirm HTTP failure, stale target or malformed response is unavailable, never absence or retry", async () => {
  for (const bad of ["http", "shape"]) {
    const h = harness();
    try {
      const id = await h.ready();
      globalThis.fetch = async () => bad === "http" ? { ok: false } : response({ action: "wrong", draft_id: "wrong" });
      await h.inbound("yes", {}, { replyToId: id });
      assert.match(h.facts.takeNotice(ctx), /unavailable/);
      await h.inbound("yes", {}, { replyToId: id });
      assert.equal(h.facts.takeNotice(ctx), undefined);
    } finally { h.close(); }
  }
});

test("current-fact recall preserves stale/conflict/unreviewed/mail/unknown/derived/source metadata before evidence", async () => {
  const block = [{ state: "conflict", current: { value: "English", privacy_class: "shareable", provenance: { evidence_date: null } },
    alternatives: [{ value: "German" }], disclosures: ["stale", "unreviewed", "mail_only", "derived", "unknown_source_date", "uncertain_validity"], source_rank: 0, source_tier: "T0_owner_asserted" }];
  const h = harness({ fetch: async () => response({ current_state: block, results: [{ text: "old evidence" }] }) });
  try {
    await h.inbound("What is my language?");
    const result = text(await h.facts.recall(ctx, { query: "language", fact_subject: "person:owner", fact_predicate: "pref.language" }));
    assert.match(result, /conflict/); assert.match(result, /stale/); assert.match(result, /evidence_date/);
    assert.equal(result.indexOf("Current facts") < result.indexOf("old evidence"), true);
    assert.match(h.calls[0].url, /fact_subject=person%3Aowner/);
  } finally { h.close(); }
});

test("restricted fields recursively withheld unless explicitly requested by owner", async () => {
  const block = [{ current: { value: "hidden", privacy_class: "restricted" }, alternatives: [{ value: "also hidden", privacy_class: "restricted" }], historical: null }, { derived_privacy_class: "restricted", derived_value: 42, source_fact_ids: ["hidden-source-id"] }];
  assert.doesNotMatch(renderCurrentState(block), /"hidden"|"also hidden"|42|hidden-source-id/);
  assert.match(renderCurrentState(block, true), /hidden/);
  assert.equal(renderCurrentState(undefined), UNAVAILABLE); assert.equal(renderCurrentState([]), UNAVAILABLE);
  for (const prompt of ["What is my language?", "Show restricted facts", "SHOW RESTRICTED FACTS!", "Do not reveal restricted facts. What is my language?", "Explain the word ‘restricted’; do not search personal data.", "Do not show restricted facts", "\"Show restricted facts\"", "> Show restricted facts", "Show restricted facts but not health"]) {
    const h = harness({ fetch: async () => response({ current_state: block, results: [] }) });
    try {
      await h.inbound(prompt);
      const result = text(await h.facts.recall(ctx, { query: "language", fact_subject: "person:owner", fact_predicate: "pref.language", include_restricted: true }));
      assert.equal(result.includes('"hidden"'), /^show restricted facts[.!]?$/iu.test(prompt));
    } finally { h.close(); }
  }
});

test("absent/malformed/failed current-state lane is unavailable; actual not_found remains explicit", async () => {
  for (const payload of [{ results: [] }, { current_state: [] }, { current_state: [{ state: "unavailable", disclosures: ["partial_lane_unavailable"] }] }, { current_state: [{ state: "not_found" }] }]) {
    const h = harness({ fetch: async () => response(payload) });
    try { await h.inbound(); const result = text(await h.facts.recall(ctx, { query: "x", fact_subject: "person:owner", fact_predicate: "pref.language" })); assert.match(result, payload.current_state?.[0]?.state === "not_found" ? /not_found/ : /unavailable/); } finally { h.close(); }
  }
  const h = harness({ fetch: async () => { throw Error("private fact"); } });
  try { await h.inbound(); assert.match(text(await h.facts.recall(ctx, {})), /unavailable/); } finally { h.close(); }
});

test("plugin exposes draft only when enabled and routes structured recall through existing unified tool", async () => {
  const h = harness({ plugin: true });
  try {
    await h.inbound("language?");
    assert.match(text(await h.tools.unified_memory_search.execute("call", { query: "language", fact_subject: "person:owner", fact_predicate: "pref.language" })), /not_found/);
    const id = await h.ready(); await h.inbound("yes", {}, { replyToId: id });
    const notice = await h.hooks.before_prompt_build({ prompt: "yes" }, { sessionKey: "private" });
    assert.match(notice.prependContext, /committed/);
  } finally { h.close(); }
});


test("forwarded or unsupported provenance cannot create drafts or recall facts", async () => {
  for (const messageProvenance of [undefined, "unknown", "forwarded"]) {
    const h = harness();
    try {
      await h.inbound("remember this: English", {}, { messageProvenance });
      assert.match(text(await h.propose()), /unavailable/);
      assert.match(text(await h.facts.recall(ctx, { query: "language" })), /unavailable/);
      assert.equal(h.calls.length, 0);
    } finally { h.close(); }
  }
});
