import test from "node:test";
import assert from "node:assert/strict";
import { createFacts } from "../src/facts.js";

const ctx = { sessionKey: "private", sessionId: "one", senderIsOwner: true, requesterSenderId: "owner", memoryAudience: { kind: "owner-private" } };
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
  const inbound = (content, event = {}, context = {}) => hooks.inbound_claim({ content, senderIsOwner: true, isGroup: false, timestamp: Date.now(), ...event }, { ...ctx, senderId: "owner", messageId: content === "yes" ? "confirm" : "proposal", ...context });
  const ready = async () => {
    await inbound("remember this: English");
    const result = await factories.memory_fact_draft(ctx).execute("call", params);
    hooks.message_sent({ success: true, messageId: "shown", content: result.content[0].text }, ctx);
  };
  return { hooks, factories, facts, calls, inbound, ready, close() { globalThis.fetch = originalFetch; delete globalThis.__factsTestCredential; } };
}

test("expiry and old session pruning forbid late confirmations and reuse", async () => {
  const realNow = Date.now, h = fixture();
  try {
    await h.ready();
    const future = realNow() + 86400001;
    Date.now = () => future;
    await h.inbound("yes", {}, { replyToId: "shown" });
    assert.equal(h.calls.length, 1);
    assert.equal(h.facts.takeNotice(ctx), undefined);
  } finally { Date.now = realNow; h.close(); }
});

test("confirmation superseded during network request never acknowledges success", async () => {
  const h = fixture();
  try {
    await h.ready();
    globalThis.fetch = async () => {
      await h.inbound("different topic");
      return { ok: true, json: async () => ({ draft_id: "d_one", action: "add" }) };
    };
    await h.inbound("yes", {}, { replyToId: "shown" });
    assert.match(h.facts.takeNotice(ctx), /unavailable/);
  } finally { h.close(); }
});

test("session start/end/reset clear pending mappings; missing key is harmless", async () => {
  for (const hook of ["session_start", "session_end", "before_reset"]) {
    const h = fixture();
    try {
      await h.ready();
      h.hooks[hook]({ sessionKey: "private" }, {});
      await h.inbound("yes", {}, { replyToId: "shown" });
      assert.equal(h.calls.length, 1);
      h.hooks[hook]({}, ctx); h.hooks[hook]({}, {});
    } finally { h.close(); }
  }
});

test("stale capture, confirmation freshness, same-origin reply and expired in-flight draft fail closed", async () => {
  const realNow = Date.now;
  for (const mode of ["capture", "confirmation", "origin", "inflight"]) {
    const h = fixture();
    try {
      const initial = realNow();
      if (mode === "capture") {
        await h.inbound("remember this: English");
        Date.now = () => initial + 400000;
        assert.match((await h.factories.memory_fact_draft(ctx).execute("call", params)).content[0].text, /unavailable/);
        assert.equal(h.calls.length, 0);
      } else {
        await h.ready();
        if (mode === "confirmation") Date.now = () => initial + 400000;
        if (mode === "inflight") globalThis.fetch = async () => {
          Date.now = () => initial + 86400001;
          return { ok: true, json: async () => ({ draft_id: "d_one", action: "add" }) };
        };
        await h.inbound("yes", { timestamp: mode === "confirmation" ? initial + 1000 : realNow() }, { replyToId: "shown", ...(mode === "origin" ? { messageId: "proposal" } : {}) });
        assert.equal(h.calls.length, 1);
        if (mode === "inflight") assert.match(h.facts.takeNotice(ctx), /unavailable/);
      }
    } finally { Date.now = realNow; h.close(); }
  }
});

test("no fact cache survives recall or forget; every recall rechecks authority and backend", async () => {
  const h = fixture();
  try {
    await h.inbound("language?");
    let state = "resolved";
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ current_state: [{ state }], results: [] }) });
    const query = { query: "language", fact_subject: "person:owner", fact_predicate: "pref.language" };
    assert.match((await h.facts.recall(ctx, query)).content[0].text, /resolved/);
    state = "not_found";
    assert.match((await h.facts.recall(ctx, query)).content[0].text, /not_found/);
    assert.match((await h.facts.recall({ ...ctx, senderIsOwner: false }, query)).content[0].text, /unavailable/);
  } finally { h.close(); }
});

test("capture revocation during request cannot install pending readback", async () => {
  const h = fixture();
  try {
    await h.inbound("remember this: English");
    globalThis.fetch = async (_url, init) => {
      await h.inbound("another topic");
      return { ok: true, json: async () => ({ ...JSON.parse(init.body), draft_id: "d", expires_at: new Date(Date.now() + 1000).toISOString() }) };
    };
    assert.match((await h.factories.memory_fact_draft(ctx).execute("call", params)).content[0].text, /unavailable/);
  } finally { h.close(); }
});
