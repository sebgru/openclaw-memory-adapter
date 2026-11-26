import test from "node:test";
import assert from "node:assert/strict";
import { createFacts } from "../src/facts.js";

const ctx = { sessionKey: "agent:main:dashboard:ae7a4c2c-7c41-447c-8796-d3c656c08127", requesterProfileId: "profile", messageChannel: "webchat", sessionId: "one", senderIsOwner: true, requesterSenderId: "owner", memoryAudience: { kind: "owner-private" }, assertMemoryAudienceCurrent() {} };
const params = { action: "add", subject: "person:owner", predicate: "pref.language", value: "English", value_type: "string", unit: null, valid_from: null, privacy_class: "shareable" };
function fixture(config = {}) {
  const hooks = {}, factories = {}, calls = [];
  globalThis.__factsTestCredential = "synthetic-only";
  const facts = createFacts({ on: (name, fn) => hooks[name] = fn, registerTool: (factory, meta) => factories[meta.name] = factory },
    { endpoint: "http://memory.test", facts: { enabled: true }, ...config });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(url);
    const body = init.body && JSON.parse(init.body);
    return { ok: true, json: async () => url.includes("/facts/drafts") ?
      { ...body, draft_id: "d_one", expires_at: new Date(Date.now() + 86400000).toISOString() } : { draft_id: "d_one", action: "add" } };
  };
  const propose = (context = ctx, value = params) => factories.memory_fact_propose(context).execute("call", value);
  const confirm = (id, context = ctx) => factories.memory_fact_confirm(context).execute("confirm", { draft_id: id });
  return { hooks, factories, facts, calls, propose, confirm, close() { globalThis.fetch = originalFetch; delete globalThis.__factsTestCredential; } };
}

test("no fact cache: every recall checks authority and backend again", async () => {
  const h = fixture();
  try {
    let state = "resolved";
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ current_state: [{ state }], results: [] }) });
    assert.match((await h.facts.recall(ctx, { query: "language", fact_subject: "person:owner", fact_predicate: "pref.language" })).content[0].text, /resolved/);
    state = "not_found";
    assert.match((await h.facts.recall(ctx, { query: "language", fact_subject: "person:owner", fact_predicate: "pref.language" })).content[0].text, /not_found/);
    assert.match((await h.facts.recall({ ...ctx, senderIsOwner: false }, {})).content[0].text, /unavailable/);
  } finally { h.close(); }
});

test("forget revokes held proposals from other sessions and clears pending drafts", async () => {
  const h = fixture();
  try {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    globalThis.fetch = async (url, init) => {
      h.calls.push(url);
      const body = JSON.parse(init.body);
      if (url.includes("/facts/drafts") && body.action === "add") await held;
      return { ok: true, json: async () => url.includes("/facts/drafts") ?
        { ...body, draft_id: body.action, expires_at: new Date(Date.now() + 60000).toISOString() } :
        { draft_id: "retract", action: "retract" } };
    };
    const old = h.propose();
    const other = { ...ctx, sessionKey: "agent:main:dashboard:be7a4c2c-7c41-447c-8796-d3c656c08127" };
    await h.propose(other, { ...params, action: "forget" });
    assert.match((await h.confirm("retract", other)).content[0].text, /committed: retract/);
    release(); assert.match((await old).content[0].text, /unavailable/);
    assert.match((await h.confirm("add")).content[0].text, /unavailable/);
    assert.equal(h.calls.filter((url) => url.endsWith("/facts/confirm")).length, 1);
  } finally { h.close(); }
});

test("concurrent confirmations consume locally once, even before backend responds", async () => {
  const h = fixture();
  try {
    await h.propose(); let release;
    globalThis.fetch = async () => new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({ draft_id: "d_one", action: "add" }) }); });
    const first = h.confirm("d_one");
    assert.match((await h.confirm("d_one")).content[0].text, /unavailable/);
    release(); assert.match((await first).content[0].text, /committed/);
    h.hooks.before_reset({}, {});
  } finally { h.close(); }
});
