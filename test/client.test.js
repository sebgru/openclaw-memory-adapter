import test from "node:test";
import assert from "node:assert/strict";
import {
    formatMemoryContext,
    normalizeConfig,
    normalizeResults,
    searchMemory,
    searchUnified,
} from "../src/client.js";
import plugin, { listAllows } from "../index.js";

test("searches with the service GET query fields and normalizes results", async () => {
    let request;
    const fetchImpl = async (url, options) => {
        request = { url, options };
        return { ok: true, async json() { return { results: [{ text: "fact", path: "MEMORY.md", score: 0.9 }] }; } };
    };
    const results = await searchMemory("where", { endpoint: "http://memory:8080" }, fetchImpl);
    assert.equal(request.url, "http://memory:8080/search?q=where&limit=5");
    assert.equal(request.options.method, "GET");
    assert.equal(request.options.body, undefined);
    assert.deepEqual(results, [{ text: "fact", source: "MEMORY.md", score: 0.9 }]);
});

test("searchUnified calls the unified endpoint with an explicit scope", async () => {
    let request;
    const fetchImpl = async (url, options) => {
        request = { url, options };
        return { ok: true, async json() { return { results: [{ text: "archive fact", source: "archive", lexical_score: 0.2, semantic_score: 0.8 }] }; } };
    };
    const results = await searchUnified("where", { endpoint: "http://memory:8080", scope: "archive" }, fetchImpl);
    assert.equal(request.url, "http://memory:8080/unified/search?q=where&limit=5&scope=archive");
    assert.equal(results[0].text, "archive fact");
    assert.equal(results[0].source, "archive");
    assert.equal(results[0].lexicalScore, 0.2);
    assert.equal(results[0].semanticScore, 0.8);
});

test("searchUnified omits scope param when scope is not set", async () => {
    let request;
    const fetchImpl = async (url, options) => {
        request = { url, options };
        return { ok: true, async json() { return { results: [] }; } };
    };
    await searchUnified("where", { endpoint: "http://memory:8080", scope: "bogus" }, fetchImpl);
    assert.equal(request.url, "http://memory:8080/unified/search?q=where&limit=5&scope=all");
});

test("searchService rejects empty queries", async () => {
    await assert.rejects(() => searchUnified("   ", { endpoint: "http://memory:8080" }, async () => ({})), /must not be empty/);
    await assert.rejects(() => searchUnified(null, { endpoint: "http://memory:8080" }, async () => ({})), /must not be empty/);
});
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

test("normalizeResults keeps rich metadata when present", () => {
    const [rich] = normalizeResults({
        results: [{
            text: "rich",
            id: "abc",
            source: "s.md",
            path: "docs/s.md",
            heading: "Intro",
            line: 12,
            lexical_score: 0.1,
            semantic_score: 0.9,
        }]
    }, 5);
    assert.equal(rich.id, "abc");
    assert.equal(rich.path, "docs/s.md");
    assert.equal(rich.heading, "Intro");
    assert.equal(rich.line, 12);
    assert.equal(rich.lexicalScore, 0.1);
    assert.equal(rich.semanticScore, 0.9);

    const [partial] = normalizeResults({ results: [{ text: "partial", source: "only", lexical_score: "bad", semantic_score: 0.5 }] }, 5);
    assert.equal(partial.lexicalScore, undefined);
    assert.equal(partial.semanticScore, 0.5);
    assert.equal(partial.path, undefined);
    assert.equal(partial.heading, undefined);
    assert.equal(partial.line, undefined);
    assert.equal(partial.id, undefined);
});

test("searchMemory uses global fetch by default", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl;
    globalThis.fetch = async (url, _options) => {
        requestUrl = url;
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
        assert.equal(requestUrl, "http://memory:8080/search?q=q&limit=5");
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

test("formatMemoryContext returns empty string for no results", () => {
    assert.equal(formatMemoryContext([]), "");
});

test("formatMemoryContext includes path and line location", () => {
    const context = formatMemoryContext([{ text: "located", source: "s.md", path: "docs/s.md", line: 7 }]);
    assert.match(context, /located \(s\.md \/ docs\/s\.md \/ line 7\)/);
});

test("formatMemoryContext truncates at maxLength", () => {
    const context = formatMemoryContext([
        { text: "short" },
        { text: "this line is far too long to fit" },
    ], 40);
    assert.match(context, /1\. short/);
    assert.doesNotMatch(context, /too long/);
});

// ── plugin entry (index.js) ──────────────────────────────────────────────────

function makeApi(config) {
    const handlers = {};
    return {
        handlers,
        pluginConfig: config,
        logger: { warn: (msg) => { handlers.lastWarn = msg; } },
        on: (name, fn) => { handlers[name] = fn; },
        registerTool: (factory, options) => { handlers.tool = typeof factory === "function" ? factory({ agentId: "a" }) : factory; handlers.toolOptions = options; },
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

test("tool honors configured scope and per-call overrides", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl;
    globalThis.fetch = async (url) => {
        requestUrl = url;
        return { ok: true, async json() { return { results: [{ text: "scoped fact" }] }; } };
    };
    try {
        const handlers = setup({ ...ENDPOINT, scope: "main" });
        await handlers.tool.execute("call-1", { query: "q" });
        assert.equal(requestUrl, "http://memory:8080/unified/search?q=q&limit=5&scope=main");
        await handlers.tool.execute("call-2", { query: "q", scope: "archive", maxResults: 3 });
        assert.equal(requestUrl, "http://memory:8080/unified/search?q=q&limit=3&scope=archive");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("tool reports no results", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, async json() { return { results: [] }; } });
    try {
        const handlers = setup(ENDPOINT);
        const result = await handlers.tool.execute("call-1", { query: "q" });
        assert.equal(result.content[0].text, "No memory results.");
        assert.deepEqual(result.details.results, []);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("prompt hook uses configured maxContextLength", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        async json() {
            return { results: [{ text: "kept" }, { text: "dropped because the limit is tiny and this line is much longer than forty characters" }] };
        },
    });
    try {
        const handlers = setup({ ...ENDPOINT, maxContextLength: 40 });
        const result = await handlers.before_prompt_build({ prompt: "hello" }, CTX);
        assert.match(result.prependContext, /kept/);
        assert.doesNotMatch(result.prependContext, /dropped/);
    } finally {
        globalThis.fetch = originalFetch;
    }
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
