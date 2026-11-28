import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import plugin from "../index.js";
import { MAIL_UNAVAILABLE_NOTICE, createMail, hasMailIntent, mailSettings } from "../src/mail.js";

const TOKEN = "synthetic-mail-token";
const owner = { sessionKey: "agent:main:dashboard:ae7a4c2c-7c41-447c-8796-d3c656c08127", sessionId: "incarnation", senderIsOwner: true, chatType: "direct", memoryAudience: { kind: "owner-private" }, assertMemoryAudienceCurrent() {} };
const base = { endpoint: "http://memory.test", mail: { enabled: true } };
const mailPayload = { results: [{ text: "Invoice from the plumber", source: "mail", path: "mail/abc.md", score: 0.9 }], coverage: { main: "not_searched", archive: "not_searched", documents: "not_searched", mail: "searched" } };
const ordinary = { results: [{ text: "ordinary memory", source: "main", path: "MEMORY.md" }], coverage: { main: "searched", archive: "searched", documents: "searched" } };
const text = (result) => result.content[0].text;

function harness({ config = {}, ctx = {}, fetch: fetchImpl, token = TOKEN } = {}) {
  const calls = [], logs = [];
  let tool;
  const api = {
    pluginConfig: { ...base, ...config },
    logger: { debug() {}, warn(message) { logs.push(message); } },
    on() {},
    registerTool(factory, meta) { if (meta.name === "unified_memory_search") tool = factory({ ...owner, ...ctx }); },
  };
  globalThis.__mailTestCredential = token;
  globalThis.__factsTestCredential = "synthetic-facts-token";
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (fetchImpl) return fetchImpl(String(url), init);
    const scope = new URL(url).searchParams.get("scope");
    return { ok: true, json: async () => (scope === "mail" ? mailPayload : ordinary) };
  };
  plugin.register(api);
  return {
    tool, calls, logs, api,
    run: (params) => tool.execute("call", params),
    mailCalls: () => calls.filter((call) => new URL(call.url).searchParams.get("scope") === "mail"),
    tokenSent: () => calls.some((call) => call.init.headers?.["x-mail-access"] !== undefined),
    close() { globalThis.fetch = previous; delete globalThis.__mailTestCredential; delete globalThis.__factsTestCredential; },
  };
}

test("manifest declares the mail SecretRef and a default-off flag", () => {
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url)));
  assert.ok(manifest.configContracts.secretInputs.paths.some((entry) => entry.path === "mail.accessToken" && entry.expected === "string"));
  assert.equal(manifest.configSchema.properties.mail.properties.enabled.default, false);
  assert.equal(manifest.configSchema.properties.mail.properties.accessToken.properties.id.const, "MEMORY_MAIL_ACCESS_TOKEN");
  assert.equal(manifest.configSchema.properties.scope.enum.includes("mail"), false);
});

test("settings: off by default and when the adapter is disabled", () => {
  assert.deepEqual(mailSettings(), { enabled: false, intentRouting: false });
  assert.deepEqual(mailSettings({ mail: { enabled: true, intentRouting: true } }), { enabled: true, intentRouting: true });
  assert.equal(mailSettings({ enabled: false, mail: { enabled: true } }).enabled, false);
});

test("mail intent detection (EN/DE/RU) ignores unrelated words", () => {
  for (const query of ["the email from the landlord", "Mail vom Vermieter", "im Posteingang", "письмо от школы", "в почте", "my inbox"]) assert.equal(hasMailIntent(query), true, query);
  for (const query of ["mailing address", "почти готово", "Rechnung Heizung", undefined]) assert.equal(hasMailIntent(query), false, String(query));
});

test("disabled: scope mail is not offered and is refused without a request", async () => {
  const h = harness({ config: { mail: undefined } });
  try {
    assert.equal(h.tool.parameters.properties.scope.enum.includes("mail"), false);
    const result = await h.run({ query: "plumber invoice", scope: "mail" });
    assert.equal(text(result), MAIL_UNAVAILABLE_NOTICE);
    assert.equal(result.details.mail, "unavailable");
    assert.equal(h.calls.length, 0);
    // Ordinary all-scope searches never carry the mail token.
    await h.run({ query: "the email from the plumber" });
    assert.equal(h.tokenSent(), false);
    assert.equal(h.mailCalls().length, 0);
  } finally { h.close(); }
});

test("owner private chat: scope mail sends the token only to the mail request", async () => {
  const h = harness();
  try {
    assert.ok(h.tool.parameters.properties.scope.enum.includes("mail"));
    const result = await h.run({ query: "plumber invoice", scope: "mail", maxResults: 3 });
    assert.match(text(result), /Private mail results/);
    assert.match(text(result), /Invoice from the plumber/);
    assert.equal(result.details.mail, "searched");
    assert.equal(h.calls.length, 1);
    const url = new URL(h.calls[0].url);
    assert.equal(url.pathname, "/unified/search");
    assert.equal(url.searchParams.get("scope"), "mail");
    assert.equal(url.searchParams.get("limit"), "3");
    assert.equal(h.calls[0].init.headers["x-mail-access"], TOKEN);
    assert.equal(h.calls[0].init.headers.authorization, undefined);
    assert.equal(h.calls[0].init.redirect, "error");
    assert.equal(h.logs.some((line) => line.includes(TOKEN) || line.includes("plumber")), false);
  } finally { h.close(); }
});

test("authorized empty mail search reports no results, not unavailable", async () => {
  const h = harness({ fetch: async () => ({ ok: true, json: async () => ({ results: [], coverage: { mail: "searched" } }) }) });
  try {
    const result = await h.run({ query: "nothing", scope: "mail" });
    assert.equal(text(result), "No private mail results.");
  } finally { h.close(); }
});

const refusals = {
  "group chat": { chatType: "group", sessionKey: "agent:main:telegram:group:-100123" },
  "channel": { chatType: "channel" },
  "other user": { senderIsOwner: false, sessionKey: "agent:main:telegram:direct:999" },
  "owner flag missing": { senderIsOwner: undefined },
  "shared audience": { memoryAudience: { kind: "shared" } },
  "cron trigger": { trigger: "cron" },
  "heartbeat": { trigger: "heartbeat" },
  "plugin-woken run": { runKind: "plugin" },
  "inter-session provenance": { inputProvenance: { kind: "inter_session" } },
  "subagent": { sessionKey: "agent:main:subagent:0734e6e6-d33f-42e9-8d2e-13f688238d43" },
  "subagent without audience": { sessionKey: "agent:main:subagent:x", memoryAudience: undefined },
  "cron session": { sessionKey: "agent:main:cron:daily" },
  "forwarded": { messageProvenance: "forwarded" },
  "one-shot cli": { oneShotCliRun: true },
  "stale invocation": { assertInvocationCurrent() { throw new Error("stale"); } },
  "stale audience": { assertMemoryAudienceCurrent() { throw new Error("stale"); } },
};
for (const [name, ctx] of Object.entries(refusals)) {
  test(`refusal (${name}): no mail request, no token, disclosed as unavailable`, async () => {
    const h = harness({ ctx, config: { mail: { enabled: true, intentRouting: true } } });
    try {
      const result = await h.run({ query: "plumber invoice", scope: "mail" });
      assert.equal(text(result), MAIL_UNAVAILABLE_NOTICE);
      assert.doesNotMatch(text(result), /No private mail results/);
      const intent = await h.run({ query: "the email from the plumber" });
      assert.match(text(intent), /Mail search unavailable/);
      assert.equal(intent.details.mail, "unavailable");
      assert.equal(h.mailCalls().length, 0);
      assert.equal(h.tokenSent(), false);
      assert.ok(h.logs.some((line) => /mail unavailable stage=tool-(?:scope|intent) reason=[A-Z_]+$/.test(line)));
    } finally { h.close(); }
  });
}

test("authority revoked while the mail request is in flight withholds results", async () => {
  let current = true;
  const h = harness({
    ctx: { assertMemoryAudienceCurrent() { if (!current) throw new Error("stale"); } },
    fetch: async () => { current = false; return { ok: true, json: async () => mailPayload }; },
  });
  try {
    const result = await h.run({ query: "plumber", scope: "mail" });
    assert.equal(text(result), MAIL_UNAVAILABLE_NOTICE);
    assert.ok(h.logs.some((line) => line.endsWith("reason=AUDIENCE_STALE")));
  } finally { h.close(); }
});

const failures = {
  SECRET_UNPREPARED: { token: "" },
  "SECRET_UNPREPARED   ": { token: null },
  "SECRET_UNPREPARED ": { token: new Error("resolver detail") },
  INVALID_ENDPOINT: { config: { endpoint: "http://user:pw@memory.test" } },
  "INVALID_ENDPOINT ": { config: { endpoint: "ftp://memory.test" } },
  "INVALID_ENDPOINT  ": { config: { endpoint: "http://[bad" } },
  HTTP_403: { fetch: async () => ({ ok: false, status: 403 }) },
  TIMEOUT: { fetch: async () => { const error = new Error("t"); error.name = "TimeoutError"; throw error; } },
  "TIMEOUT ": { fetch: async () => { const error = new Error("a"); error.name = "AbortError"; throw error; } },
  TRANSPORT: { fetch: async () => { throw new Error("connect refused http://memory.test"); } },
  RESPONSE_SHAPE: { fetch: async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }) },
  MAIL_NOT_SEARCHED: { fetch: async () => ({ ok: true, json: async () => ({ results: [], coverage: { mail: "unavailable" } }) }) },
  "MAIL_NOT_SEARCHED ": { fetch: async () => ({ ok: true, json: async () => null }) },
};
for (const [reason, options] of Object.entries(failures)) {
  test(`failure ${reason.trim()} is disclosed as unavailable with a static reason`, async () => {
    const h = harness(options);
    try {
      const result = await h.run({ query: "plumber", scope: "mail" });
      assert.equal(text(result), MAIL_UNAVAILABLE_NOTICE);
      assert.equal(result.details.mail, "unavailable");
      assert.ok(h.logs.some((line) => line.endsWith(`reason=${reason.trim()}`)), h.logs.join("\n"));
      assert.equal(h.logs.some((line) => /resolver detail|connect refused|plumber/.test(line)), false);
    } finally { h.close(); }
  });
}

test("unexpected errors are logged as UNKNOWN", async () => {
  const logs = [];
  const mail = createMail({ logger: { warn(message) { logs.push(message); } } }, base);
  const lane = await mail.lane({ get senderIsOwner() { throw new Error("boom"); } }, "q", 1, "tool-scope");
  assert.deepEqual(lane, { unavailable: true });
  assert.deepEqual(logs, ["memory-adapter: mail unavailable stage=tool-scope reason=UNKNOWN"]);
  // A missing logger must not throw.
  assert.deepEqual(await createMail({}, base).lane({}, "q", 1, "tool-scope"), { unavailable: true });
});

test("intent routing off: all-scope mail wording does not search mail", async () => {
  const h = harness();
  try {
    const result = await h.run({ query: "the email from the plumber" });
    assert.match(text(result), /ordinary memory/);
    assert.equal(result.details.mail, undefined);
    assert.equal(h.mailCalls().length, 0);
  } finally { h.close(); }
});

test("intent routing on: owner all-scope mail query adds a labelled mail section", async () => {
  const h = harness({ config: { mail: { enabled: true, intentRouting: true } } });
  try {
    const result = await h.run({ query: "the email from the plumber" });
    assert.match(text(result), /ordinary memory[\s\S]*Private mail results[\s\S]*Invoice from the plumber/);
    assert.equal(result.details.mail, "searched");
    assert.equal(result.details.mailResults.length, 1);
    assert.equal(h.mailCalls().length, 1);
    const ordinaryCall = h.calls.find((call) => new URL(call.url).searchParams.get("scope") === "all");
    assert.equal(ordinaryCall.init.headers["x-mail-access"], undefined);
    // No mail wording, or a non-all scope: no mail lane.
    await h.run({ query: "plumber invoice" });
    await h.run({ query: "the email from the plumber", scope: "documents" });
    assert.equal(h.mailCalls().length, 1);
  } finally { h.close(); }
});

test("intent routing composes with the facts lane", async () => {
  const h = harness({
    config: { mail: { enabled: true, intentRouting: true }, facts: { enabled: true } },
    fetch: async (url) => {
      const scope = new URL(url).searchParams.get("scope");
      if (scope === "mail") return { ok: true, json: async () => mailPayload };
      if (url.includes("/facts/current")) return { ok: true, json: async () => ({ state: "not_found" }) };
      return { ok: true, json: async () => ({ ...ordinary, current_state: [{ state: "not_found" }] }) };
    },
  });
  try {
    const result = await h.run({ query: "the email from the plumber" });
    assert.match(text(result), /Current facts[\s\S]*Private mail results/);
    assert.equal(result.details.mail, "searched");
    // The facts bearer token and the mail token never share a request.
    for (const call of h.calls) assert.ok(!(call.init.headers?.authorization && call.init.headers?.["x-mail-access"]));
    // Explicit scope=mail bypasses the facts lane entirely.
    const before = h.calls.length;
    await h.run({ query: "plumber", scope: "mail", fact_subject: "person:owner" });
    assert.equal(h.calls.length, before + 1);
  } finally { h.close(); }
});
