import test from "node:test";
import assert from "node:assert/strict";
import {
    formatMemoryContext,
    normalizeConfig,
    normalizeResults,
    searchMemory,
} from "../src/client.js";
import plugin, { listAllows } from "../index.js";

const ENDPOINT = { endpoint: "http://memory:8080" };

// ── normalizeConfig ──────────────────────────────────────────────────────────

test("normalizeConfig rejects missing endpoint", () => {
    assert.throws(() => normalizeConfig({}), /http\(s\) URL/);
    assert.throws(() => normalizeConfig({ endpoint: "ftp://x" }), /http\(s\) URL/);
});

test("normalizeConfig trims and strips trailing slash", () => {
    const config = normalizeConfig({ endpoint: " http://memory:8080/ " });
    assert.equal(config.endpoint, "http://memory:8080");
});

test("normalizeConfig applies defaults and keeps valid integers", () => {
    const defaults = normalizeConfig(ENDPOINT);
    assert.equal(defaults.timeoutMs, 1500);
    assert.equal(defaults.maxResults, 5);
    const custom = normalizeConfig({ ...ENDPOINT, timeoutMs: 500, maxResults: 2 });
    assert.equal(custom.timeoutMs, 500);
    assert.equal(custom.maxResults, 2);
    const invalid = normalizeConfig({ ...ENDPOINT, timeoutMs: 1.5, maxResults: "x" });
    assert.equal(invalid.timeoutMs, 1500);
    assert.equal(invalid.maxResults, 5);
});

// ── normalizeResults ─────────────────────────────────────────────────────────

test("normalizeResults handles array payloads, content field and missing score", () => {
    const payload = [
        { content: "a" },
        { text: "b", source: "s" },
        { text: "c", score: "not-a-number" },
    ];
    assert.deepEqual(normalizeResults(payload, 5), [
        { text: "a", source: "", score: undefined },
        { text: "b", source: "s", score: undefined },
        { text: "c", source: "", score: undefined },
    ]);
});

test("normalizeResults respects maxResults and trims text", () => {
    const payload = { results: [{ text: "  spaced  " }, { text: "second" }] };
    assert.deepEqual(normalizeResults(payload, 1), [
        { text: "spaced", source: "", score: undefined },
    ]);
});

test("normalizeResults returns [] for non-object and non-array payloads", () => {
    assert.deepEqual(normalizeResults(null, 5), []);
    assert.deepEqual(normalizeResults("nope", 5), []);
    assert.deepEqual(normalizeResults({ results: "nope" }, 5), []);
    assert.deepEqual(normalizeResults({ results: [42, [1], () => { }] }, 5), []);
});

test("normalizeResults falls back to path and numeric score", () => {
    assert.deepEqual(
        normalizeResults({ results: [{ text: "x", path: "p.md", score: 2 }] }, 5),
        [{ text: "x", source: "p.md", score: 2 }],
    );
    assert.deepEqual(normalizeResults({ results: [{ text: "x", source: 7 }] }, 5)[0].source, "7");
});

test("searchMemory uses global fetch by default", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody;
    globalThis.fetch = async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {
            ok: true,
            async json() {
                return { results: [{ text: "default fetch used" }] };
            },
        };
    };
    try {
        assert.deepEqual(await searchMemory("q", ENDPOINT), [
            { text: "default fetch used", source: "", score: undefined },
        ]);
        assert.deepEqual(requestBody, { q: "q", limit: 5 });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("searchMemory rejects non-ok responses", async () => {
    await assert.rejects(
        () =>
            searchMemory(
                "q",
                ENDPOINT,
                async () => ({ ok: false, status: 503 }),
            ),
        /HTTP 503/,
    );
});

test("searchMemory propagates invalid config", async () => {
    await assert.rejects(() => searchMemory("q", {}, async () => ({})), /endpoint/);
});

test("searchMemory aborts when the timeout elapses", async () => {
    const fetchImpl = async (_url, options) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        options.signal.throwIfAborted();
        return { ok: true, async json() { return []; } };
    };
    await assert.rejects(
        () => searchMemory("q", { ...ENDPOINT, timeoutMs: 20 }, fetchImpl),
        /abort/i,
    );
});

test("searchMemory returns array payload directly", async () => {
    const fetchImpl = async () => ({
        ok: true,
        async json() {
            return [{ text: "from array" }];
        },
    });
    assert.deepEqual(await searchMemory("q", ENDPOINT, fetchImpl), [
        { text: "from array", source: "", score: undefined },
    ]);
});

// ── formatMemoryContext ──────────────────────────────────────────────────────

test("formatMemoryContext numbers results and includes sources", () => {
    const context = formatMemoryContext([
        { text: "first" },
        { text: "second", source: "a.md" },
    ]);
    assert.match(context, /^Relevant external memory/);
    assert.match(context, /1\. first/);
    assert.match(context, /2\. second \(a\.md\)/);
});

// ── plugin entry (index.js) ──────────────────────────────────────────────────

function makeApi(config) {
    const handlers = {};
    return {
        handlers,
        pluginConfig: config,
        logger: { warn: (msg) => { handlers.lastWarn = msg; } },
        on: (name, fn) => { handlers[name] = fn; },
    };
}

function setup(config) {
    const api = makeApi(config);
    plugin.register(api);
    return api.handlers;
}

const CTX = { agentId: "a", chatType: "direct", chatId: "1" };

test("register subscribes to before_prompt_build", () => {
    const handlers = setup({ endpoint: "http://memory:8080" });
    assert.equal(typeof handlers.before_prompt_build, "function");
});

test("register tolerates missing pluginConfig", async () => {
    const api = makeApi(undefined);
    api.pluginConfig = undefined;
    plugin.register(api);
    assert.equal(typeof api.handlers.before_prompt_build, "function");
    const result = await api.handlers.before_prompt_build({ prompt: "" }, CTX);
    assert.equal(result, undefined);
});

test("eligible returns undefined for empty or non-string prompts", async () => {
    const handlers = setup({ endpoint: "http://memory:8080" });
    assert.equal(await handlers.before_prompt_build({ prompt: "" }, CTX), undefined);
    assert.equal(await handlers.before_prompt_build({ prompt: "   " }, CTX), undefined);
    assert.equal(await handlers.before_prompt_build({}, CTX), undefined);
    assert.equal(await handlers.before_prompt_build({ prompt: 42 }, CTX), undefined);
});

test("eligible blocks disabled plugins and non-allowed agents/chats", async () => {
    const disabled = setup({ endpoint: ENDPOINT.endpoint, enabled: false });
    assert.equal(await disabled.before_prompt_build({ prompt: "x" }, CTX), undefined);
    const agentBlocked = setup({ ...ENDPOINT, agents: ["other"] });
    assert.equal(await agentBlocked.before_prompt_build({ prompt: "x" }, CTX), undefined);
    const typeBlocked = setup({ ...ENDPOINT, allowedChatTypes: ["group"] });
    assert.equal(await typeBlocked.before_prompt_build({ prompt: "x" }, CTX), undefined);
    const idBlocked = setup({ ...ENDPOINT, allowedChatIds: ["99"] });
    assert.equal(await idBlocked.before_prompt_build({ prompt: "x" }, CTX), undefined);
});

test("listAllows passes for missing, empty and matching lists", () => {
    assert.equal(listAllows(undefined, "a"), true);
    assert.equal(listAllows([], "a"), true);
    assert.equal(listAllows(["a"], "a"), true);
    assert.equal(listAllows(["a"], "b"), false);
    assert.ok(!listAllows(["a"], undefined));
});

test("successful retrieval prepends formatted context", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        async json() {
            return { results: [{ text: "remembered fact", source: "MEMORY.md" }] };
        },
    });
    try {
        const handlers = setup(ENDPOINT);
        const result = await handlers.before_prompt_build({ prompt: "hello" }, CTX);
        assert.ok(result.prependContext.startsWith("Relevant external memory"));
        assert.match(result.prependContext, /remembered fact \(MEMORY\.md\)/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("failed retrieval warns and fails closed", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        throw new Error("connection refused");
    };
    try {
        const api = makeApi(ENDPOINT);
        plugin.register(api);
        const result = await api.handlers.before_prompt_build({ prompt: "hello" }, CTX);
        assert.equal(result, undefined);
        assert.match(api.handlers.lastWarn, /retrieval skipped/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("missing logger.warn is tolerated", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        throw new Error("down");
    };
    try {
        const api = makeApi(ENDPOINT);
        api.logger = {};
        plugin.register(api);
        const result = await api.handlers.before_prompt_build({ prompt: "hello" }, CTX);
        assert.equal(result, undefined);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("empty retrieval results do not prepend context", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        async json() {
            return { results: [] };
        },
    });
    try {
        const handlers = setup(ENDPOINT);
        const result = await handlers.before_prompt_build({ prompt: "hello" }, CTX);
        assert.equal(result, undefined);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
