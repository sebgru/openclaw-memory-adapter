import test from "node:test";
import assert from "node:assert/strict";
import {
    buildMemoryContextDetails,
    formatMemoryContext,
    normalizeConfig,
    normalizeCoverage,
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

test("searchUnified calls the unified endpoint with scope and profile", async () => {
    let request;
    const fetchImpl = async (url, options) => {
        request = { url, options };
        return { ok: true, async json() { return { results: [{ text: "archive fact", source: "archive", lexical_score: 0.2, semantic_score: 0.8 }] }; } };
    };
    const { results } = await searchUnified("where", { endpoint: "http://memory:8080", scope: "archive", profile: "tool" }, fetchImpl);
    assert.equal(request.url, "http://memory:8080/unified/search?q=where&limit=5&scope=archive&profile=tool");
    assert.equal(results[0].text, "archive fact");
    assert.equal(results[0].source, "archive");
    assert.equal(results[0].lexicalScore, 0.2);
    assert.equal(results[0].semanticScore, 0.8);
});

test("searchUnified defaults scope to all and omits profile when unset", async () => {
    let request;
    const fetchImpl = async (url, options) => {
        request = { url, options };
        return { ok: true, async json() { return { results: [] }; } };
    };
    await searchUnified("where", { endpoint: "http://memory:8080", scope: "bogus" }, fetchImpl);
    assert.equal(request.url, "http://memory:8080/unified/search?q=where&limit=5&scope=all");
});

test("searchUnified accepts documents scope", async () => {
    let request;
    const fetchImpl = async (url, options) => {
        request = { url, options };
        return { ok: true, async json() { return { results: [] }; } };
    };
    await searchUnified("where", { endpoint: "http://memory:8080", scope: "documents" }, fetchImpl);
    assert.equal(request.url, "http://memory:8080/unified/search?q=where&limit=5&scope=documents");
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

test("normalizeConfig validates scope and profile enums", () => {
    assert.equal(normalizeConfig({ ...ENDPOINT, scope: "documents" }).scope, "documents");
    assert.equal(normalizeConfig({ ...ENDPOINT, scope: "bogus" }).scope, "all");
    assert.equal(normalizeConfig({ ...ENDPOINT, profile: "prompt" }).profile, "prompt");
    assert.equal(normalizeConfig({ ...ENDPOINT, profile: "tool" }).profile, "tool");
    assert.equal(normalizeConfig({ ...ENDPOINT, profile: "bogus" }).profile, undefined);
    assert.equal(normalizeConfig(ENDPOINT).profile, undefined);
});

test("deduplication is explicitly opt-in", () => {
    assert.equal(normalizeConfig(ENDPOINT).deduplicateResults, false);
    assert.equal(normalizeConfig({ ...ENDPOINT, deduplicateResults: true }).deduplicateResults, true);
    assert.equal(normalizeConfig({ ...ENDPOINT, deduplicateResults: "true" }).deduplicateResults, false);
});

test("opt-in deduplication retains the first ranked result for stable IDs and locations", async () => {
    const payload = { results: [
        { id: "same", text: "first", source: "main" },
        { id: "same", text: "second", source: "archive" },
        { text: "third", source: "documents", path: "file.md", line: 7 },
        { text: "fourth", source: "documents", path: "file.md", line: 7 },
        { text: "fifth", source: "documents", path: "file.md", line: 8 },
    ] };
    const fetchImpl = async () => ({ ok: true, json: async () => payload });
    const legacy = await searchUnified("q", { ...ENDPOINT, maxResults: 5 }, fetchImpl);
    const deduped = await searchUnified("q", { ...ENDPOINT, maxResults: 5, deduplicateResults: true }, fetchImpl);
    assert.equal(legacy.results.length, 5);
    assert.deepEqual(deduped.results.map(({ text }) => text), ["first", "third", "fifth"]);
});

test("deduplication does not conflate unlocated chunks or different source paths", () => {
    const payload = { results: [
        { text: "A", source: "documents" },
        { text: "B", source: "documents" },
        { text: "C", source: "documents", path: "one.md", line: 1 },
        { text: "D", source: "archive", path: "one.md", line: 1 },
        { text: "E", source: "documents", path: "two.md", line: 1 },
    ] };
    assert.deepEqual(normalizeResults(payload, 5, 2000, true).results.map(({ text }) => text), ["A", "B", "C", "D", "E"]);
});

// ── normalizeResults ─────────────────────────────────────────────────────────

test("normalizeResults handles array payloads, content field and missing score", () => {
    const payload = [
        { content: "a" },
        { text: "b", source: "s" },
        { text: "c", score: "not-a-number" },
    ];
    assert.deepEqual(normalizeResults(payload, 5).results, [
        { text: "a", source: "", score: undefined },
        { text: "b", source: "s", score: undefined },
        { text: "c", source: "", score: undefined },
    ]);
});

test("normalizeResults respects maxResults and trims text", () => {
    const payload = { results: [{ text: "  spaced  " }, { text: "second" }] };
    assert.deepEqual(normalizeResults(payload, 1).results, [
        { text: "spaced", source: "", score: undefined },
    ]);
});

test("normalizeResults returns empty for non-object and non-array payloads", () => {
    assert.deepEqual(normalizeResults(null, 5).results, []);
    assert.deepEqual(normalizeResults("nope", 5).results, []);
    assert.deepEqual(normalizeResults({ results: "nope" }, 5).results, []);
    assert.deepEqual(normalizeResults({ results: [42, [1], () => { }] }, 5).results, []);
});

test("normalizeResults falls back to path and numeric score", () => {
    assert.deepEqual(
        normalizeResults({ results: [{ text: "x", path: "p.md", score: 2 }] }, 5).results,
        [{ text: "x", source: "p.md", score: 2 }],
    );
    assert.deepEqual(normalizeResults({ results: [{ text: "x", source: 7 }] }, 5).results[0].source, "7");
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
            relevance_score: 0.95,
            provenance: "daily/2026-09-01.md",
            alternate_provenance: "sessions/2026/09/abc.md",
        }]
    }, 5).results;
    assert.equal(rich.id, "abc");
    assert.equal(rich.path, "docs/s.md");
    assert.equal(rich.heading, "Intro");
    assert.equal(rich.line, 12);
    assert.equal(rich.lexicalScore, 0.1);
    assert.equal(rich.semanticScore, 0.9);
    assert.equal(rich.relevanceScore, 0.95);
    assert.equal(rich.provenance, "daily/2026-09-01.md");
    assert.equal(rich.alternateProvenance, "sessions/2026/09/abc.md");

    const [partial] = normalizeResults({ results: [{ text: "partial", source: "only", lexical_score: "bad", semantic_score: 0.5 }] }, 5).results;
    assert.equal(partial.lexicalScore, undefined);
    assert.equal(partial.semanticScore, 0.5);
    assert.equal(partial.relevanceScore, undefined);
    assert.equal(partial.provenance, undefined);
    assert.equal(partial.alternateProvenance, undefined);
    assert.equal(partial.path, undefined);
    assert.equal(partial.heading, undefined);
    assert.equal(partial.line, undefined);
    assert.equal(partial.id, undefined);
});

test("normalizeResults extracts conflicts from object payload and bounds them", () => {
    const { conflicts } = normalizeResults({
        results: [{ text: "ok" }],
        conflicts: ["a", "b", "c", "d", "e", "f"],
    }, 5);
    assert.equal(conflicts.length, 5);
});

test("normalizeResults tolerates missing conflicts and array payloads", () => {
    assert.deepEqual(normalizeResults({ results: [] }, 5).conflicts, []);
    assert.deepEqual(normalizeResults([{ text: "x" }], 5).conflicts, []);
    assert.deepEqual(normalizeResults("nope", 5).conflicts, []);
});

test("normalizeResults extracts warnings from object payload", () => {
    const { warnings, results } = normalizeResults({
        results: [{ text: "ok" }],
        warnings: ["index stale", "partial results"],
    }, 5);
    assert.deepEqual(warnings, ["index stale", "partial results"]);
    assert.equal(results.length, 1);
});

test("normalizeResults bounds warnings and tolerates missing warnings", () => {
    const many = normalizeResults({ results: [], warnings: ["a", "b", "c", "d", "e", "f"] }, 5);
    assert.equal(many.warnings.length, 5);
    const none = normalizeResults({ results: [] }, 5);
    assert.deepEqual(none.warnings, []);
    const arr = normalizeResults([{ text: "x" }], 5);
    assert.deepEqual(arr.warnings, []);
});

test("normalizeResults sanitizes and caps each service warning and conflict", () => {
    const result = normalizeResults({
        results: [],
        warnings: [`first\nline${"x".repeat(300)}`],
        conflicts: ["left\u0000right"],
    }, 5);
    assert.equal(result.warnings[0].length, 256);
    assert.ok(result.warnings[0].startsWith("first line"));
    assert.deepEqual(result.conflicts, ["left right"]);
});

test("normalizeResults bounds per-result text to maxResultTextLength", () => {
    const long = "x".repeat(3000);
    const [r] = normalizeResults({ results: [{ text: long }] }, 5, 100).results;
    assert.equal(r.text.length, 101); // 100 + ellipsis
    assert.ok(r.text.endsWith("…"));
    const [short] = normalizeResults({ results: [{ text: "brief" }] }, 5, 100).results;
    assert.equal(short.text, "brief");
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

test("buildMemoryContextDetails reports not-truncated and includedCount for empty results", () => {
    assert.deepEqual(buildMemoryContextDetails([]), { text: "", truncated: false, includedCount: 0 });
});

test("buildMemoryContextDetails reports truncated=false and includedCount when everything fits", () => {
    const details = buildMemoryContextDetails([{ text: "first" }, { text: "second" }]);
    assert.equal(details.truncated, false);
    assert.equal(details.includedCount, 2);
    assert.match(details.text, /1\. first/);
});

test("buildMemoryContextDetails reports truncated=true and the included count when a line is dropped", () => {
    const details = buildMemoryContextDetails([
        { text: "short" },
        { text: "this line is far too long to fit" },
    ], 40);
    assert.equal(details.truncated, true);
    assert.equal(details.includedCount, 1);
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
    handlers.debugLogs = [];
    return {
        handlers,
        pluginConfig: config,
        logger: {
            warn: (msg) => { handlers.lastWarn = msg; },
            debug: (msg) => { handlers.debugLogs.push(msg); handlers.lastDebug = msg; },
        },
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

test("plugin declares and registers unified_memory_search as a callable tool", () => {
    const handlers = setup(ENDPOINT);
    assert.deepEqual(plugin.contracts.tools, ["unified_memory_search"]);
    assert.equal(handlers.toolOptions.name, "unified_memory_search");
    assert.equal(handlers.tool.name, "unified_memory_search");
    assert.equal(typeof handlers.tool.execute, "function");
});

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

test("tool honors configured scope and per-call overrides including documents", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl;
    globalThis.fetch = async (url) => {
        requestUrl = url;
        return { ok: true, async json() { return { results: [{ text: "scoped fact" }] }; } };
    };
    try {
        const handlers = setup({ ...ENDPOINT, scope: "main" });
        await handlers.tool.execute("call-1", { query: "q" });
        assert.match(requestUrl, /scope=main/);
        assert.match(requestUrl, /profile=tool/);
        await handlers.tool.execute("call-2", { query: "q", scope: "archive", maxResults: 3 });
        assert.match(requestUrl, /scope=archive/);
        assert.match(requestUrl, /limit=3/);
        await handlers.tool.execute("call-3", { query: "q", scope: "documents" });
        assert.match(requestUrl, /scope=documents/);
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

test("prompt hook uses scope=all and profile=prompt", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl;
    globalThis.fetch = async (url) => {
        requestUrl = url;
        return { ok: true, async json() { return { results: [{ text: "hook fact" }] }; } };
    };
    try {
        const handlers = setup(ENDPOINT);
        const result = await handlers.before_prompt_build({ prompt: "hello" }, CTX);
        assert.match(requestUrl, /scope=all/);
        assert.match(requestUrl, /profile=prompt/);
        assert.ok(result.prependContext.startsWith("Relevant external memory"));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("tool uses profile=tool and lets caller pick scope", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl;
    globalThis.fetch = async (url) => {
        requestUrl = url;
        return { ok: true, async json() { return { results: [{ text: "tool fact" }] }; } };
    };
    try {
        const handlers = setup(ENDPOINT);
        await handlers.tool.execute("call-1", { query: "q", scope: "main" });
        assert.match(requestUrl, /scope=main/);
        assert.match(requestUrl, /profile=tool/);
        await handlers.tool.execute("call-2", { query: "q" });
        assert.match(requestUrl, /scope=all/);
        assert.match(requestUrl, /profile=tool/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("hook surfaces warnings with results and still prepends context", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        async json() {
            return { results: [{ text: "fact", source: "MEMORY.md" }], warnings: ["index stale"] };
        },
    });
    try {
        const api = makeApi(ENDPOINT);
        plugin.register(api);
        const result = await api.handlers.before_prompt_build({ prompt: "hello" }, CTX);
        assert.ok(result.prependContext.includes("fact"));
        assert.match(api.handlers.lastWarn, /1 warning/);
        assert.doesNotMatch(api.handlers.lastWarn, /index stale/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("hook returns failure notice on hard failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("connection refused"); };
    try {
        const api = makeApi(ENDPOINT);
        plugin.register(api);
        const result = await api.handlers.before_prompt_build({ prompt: "hello" }, CTX);
        assert.ok(result.prependContext);
        assert.match(result.prependContext, /do not assert facts from memory/);
        assert.match(api.handlers.lastWarn, /retrieval failed/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("tool returns failure notice on hard failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("connection refused"); };
    try {
        const handlers = setup(ENDPOINT);
        const result = await handlers.tool.execute("call-1", { query: "q" });
        assert.match(result.content[0].text, /do not assert facts from memory/);
        assert.ok(result.details.error);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("tool passes through service-reported conflicts in details", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        async json() {
            return { results: [{ text: "fact" }], conflicts: ["fact vs other fact"] };
        },
    });
    try {
        const handlers = setup(ENDPOINT);
        const result = await handlers.tool.execute("call-1", { query: "q" });
        assert.deepEqual(result.details.conflicts, ["fact vs other fact"]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("tool surfaces warnings alongside results", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        async json() {
            return { results: [{ text: "fact" }], warnings: ["partial index", "degraded"] };
        },
    });
    try {
        const handlers = setup(ENDPOINT);
        const result = await handlers.tool.execute("call-1", { query: "q" });
        assert.match(result.content[0].text, /fact/);
        assert.match(result.content[0].text, /Warnings: partial index; degraded/);
        assert.deepEqual(result.details.warnings, ["partial index", "degraded"]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("tool surfaces warnings even with no results", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        async json() {
            return { results: [], warnings: ["index empty"] };
        },
    });
    try {
        const handlers = setup(ENDPOINT);
        const result = await handlers.tool.execute("call-1", { query: "q" });
        assert.match(result.content[0].text, /No memory results/);
        assert.match(result.content[0].text, /Warnings: index empty/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("prompt hook caps total context to maxContextLength", async () => {
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

// ── turnReceipts flag (default off; §5A per-turn receipt behavior) ─────────

test("turnReceipts off (default): zero-result turns remain silent, unchanged from legacy behavior", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, async json() { return { results: [] }; } });
    try {
        const handlers = setup(ENDPOINT);
        const result = await handlers.before_prompt_build({ prompt: "hello" }, CTX);
        assert.equal(result, undefined);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("turnReceipts on: zero-result turns produce an explicit absent notice instead of silence", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, async json() { return { results: [] }; } });
    try {
        const handlers = setup({ ...ENDPOINT, turnReceipts: true });
        const result = await handlers.before_prompt_build({ prompt: "hello" }, CTX);
        assert.ok(result?.prependContext);
        assert.match(result.prependContext, /verified absence/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("turnReceipts on: found results still prepend plain context with no extra notice", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, async json() { return { results: [{ text: "fact" }] }; } });
    try {
        const handlers = setup({ ...ENDPOINT, turnReceipts: true });
        const result = await handlers.before_prompt_build({ prompt: "hello" }, CTX);
        assert.ok(result.prependContext.startsWith("Relevant external memory"));
        assert.doesNotMatch(result.prependContext, /verified absence/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("turnReceipts on: service-reported conflicts are surfaced alongside the retrieved context", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        async json() { return { results: [{ text: "fact a" }], conflicts: ["fact a vs fact b"] }; },
    });
    try {
        const handlers = setup({ ...ENDPOINT, turnReceipts: true });
        const result = await handlers.before_prompt_build({ prompt: "hello" }, CTX);
        assert.match(result.prependContext, /fact a/);
        assert.match(result.prependContext, /conflicting evidence/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("turnReceipts on: hard failure is surfaced as unavailable, not absence", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("connection refused"); };
    try {
        const handlers = setup({ ...ENDPOINT, turnReceipts: true });
        const result = await handlers.before_prompt_build({ prompt: "hello" }, CTX);
        assert.match(result.prependContext, /retrieval unavailable/);
        assert.doesNotMatch(result.prependContext, /verified absence/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("turnReceipts on: prefers event.currentUserMessageId, falls back to ctx.runId, then generates an id", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, async json() { return { results: [] }; } });
    try {
        const handlers = setup({ ...ENDPOINT, turnReceipts: true });
        // No throw means turn-id derivation succeeded for all branches below.
        await handlers.before_prompt_build({ prompt: "hello", currentUserMessageId: "msg-1" }, CTX);
        await handlers.before_prompt_build({ prompt: "hello" }, { ...CTX, runId: "run-1" });
        await handlers.before_prompt_build({ prompt: "hello" }, CTX);
    } finally {
        globalThis.fetch = originalFetch;
    }
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
        assert.ok(result.prependContext);
        assert.match(result.prependContext, /do not assert facts from memory/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("provenance and alternate_provenance pass through to normalized results", async () => {
    const fetchImpl = async () => ({
        ok: true,
        async json() {
            return {
                results: [{
                    text: "proven fact",
                    source: "memory",
                    path: "MEMORY.md",
                    relevance_score: 0.92,
                    provenance: "memory/2026-09-01.md",
                    alternate_provenance: "sessions/2026/09/abc.md",
                }],
            };
        },
    });
    const { results } = await searchUnified("q", ENDPOINT, fetchImpl);
    assert.equal(results[0].relevanceScore, 0.92);
    assert.equal(results[0].provenance, "memory/2026-09-01.md");
    assert.equal(results[0].alternateProvenance, "sessions/2026/09/abc.md");
});

// ── §5A follow-up: honest partial coverage, zero-included-content, trace ────

test("turnReceipts on: scope=all with warnings surfaces partial coverage alongside found results instead of hiding them", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        async json() {
            return { results: [{ text: "fact", source: "MEMORY.md" }], warnings: ["archive index unavailable"] };
        },
    });
    try {
        const api = makeApi({ ...ENDPOINT, turnReceipts: true });
        plugin.register(api);
        const result = await api.handlers.before_prompt_build({ prompt: "hello" }, CTX);
        assert.match(result.prependContext, /fact/);
        assert.match(result.prependContext, /coverage for this turn is unverified/);
        assert.match(result.prependContext, /service reported 1 warning/);
        assert.doesNotMatch(result.prependContext, /archive index unavailable/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("turnReceipts on: zero-length context budget drops header-only output and tells the model nothing usable was attached", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        async json() {
            return { results: [{ text: "this single result is far too long to fit inside a tiny context budget" }] };
        },
    });
    try {
        const handlers = setup({ ...ENDPOINT, turnReceipts: true, maxContextLength: 10 });
        const result = await handlers.before_prompt_build({ prompt: "hello" }, CTX);
        assert.ok(result?.prependContext);
        assert.doesNotMatch(result.prependContext, /Relevant external memory/);
        assert.match(result.prependContext, /none of the retrieved content could be attached/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("turnReceipts on: emits a bounded JSON receipt trace via the plugin logger with no raw query/result text", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        async json() {
            return { results: [{ text: "super secret memory content" }] };
        },
    });
    try {
        const api = makeApi({ ...ENDPOINT, turnReceipts: true });
        plugin.register(api);
        await api.handlers.before_prompt_build({ prompt: "what did we decide", currentUserMessageId: "msg-7" }, CTX);
        assert.equal(api.handlers.debugLogs.length, 1);
        const [line] = api.handlers.debugLogs;
        assert.match(line, /^memory-adapter: receipt /);
        const payload = JSON.parse(line.slice("memory-adapter: receipt ".length));
        assert.equal(payload.turnId, "msg-7");
        assert.equal(payload.status, "found");
        assert.ok(Number.isInteger(payload.schemaVersion));
        assert.ok(payload.timing);
        assert.deepEqual(Object.keys(payload.sources).sort(), ["absent", "notSearched", "searched", "unavailable", "unknownCoverage"]);
        assert.doesNotMatch(line, /super secret memory content/);
        assert.doesNotMatch(line, /what did we decide/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("turnReceipts on: receipt trace is also emitted on hard failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("connection refused"); };
    try {
        const api = makeApi({ ...ENDPOINT, turnReceipts: true });
        plugin.register(api);
        await api.handlers.before_prompt_build({ prompt: "hello" }, CTX);
        assert.equal(api.handlers.debugLogs.length, 1);
        const payload = JSON.parse(api.handlers.debugLogs[0].slice("memory-adapter: receipt ".length));
        assert.equal(payload.status, "unavailable");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("turnReceipts off: no receipt trace is logged (legacy behavior untouched)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, async json() { return { results: [{ text: "fact" }] }; } });
    try {
        const api = makeApi(ENDPOINT);
        plugin.register(api);
        await api.handlers.before_prompt_build({ prompt: "hello" }, CTX);
        assert.deepEqual(api.handlers.debugLogs, []);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("searchUnified bounds query length via config", async () => {
    let request;
    const fetchImpl = async (url) => {
        request = { url };
        return { ok: true, async json() { return { results: [] }; } };
    };
    const longQuery = "a".repeat(5000);
    await searchUnified(longQuery, { ...ENDPOINT, maxQueryLength: 200 }, fetchImpl);
    const url = new URL(request.url);
    assert.equal(url.searchParams.get("q").length, 200);
});

// ── service-reported coverage ────────────────────────────────────────────────

test("normalizeCoverage keeps only valid sources/states and is empty when invalid, undefined only when omitted", () => {
    assert.deepEqual(normalizeCoverage({ main: "searched", archive: "unavailable", documents: "bogus", extra: "searched" }), { main: "searched", archive: "unavailable" });
    assert.equal(normalizeCoverage(undefined), undefined);
    assert.deepEqual(normalizeCoverage({ main: "bogus" }), {});
    assert.deepEqual(normalizeCoverage({}), {});
    assert.deepEqual(normalizeCoverage(null), {});
    assert.deepEqual(normalizeCoverage(["searched"]), {});
    assert.deepEqual(normalizeCoverage("searched"), {});
});

test("normalizeResults passes through coverage only when reported", () => {
    assert.deepEqual(normalizeResults({ results: [], coverage: { main: "searched" } }, 5).coverage, { main: "searched" });
    assert.equal("coverage" in normalizeResults({ results: [] }, 5), false);
    assert.equal("coverage" in normalizeResults([], 5), false);
    // present-but-invalid coverage is preserved as an empty map, not dropped
    assert.deepEqual(normalizeResults({ results: [], coverage: {} }, 5).coverage, {});
    assert.deepEqual(normalizeResults({ results: [], coverage: { main: "bogus" } }, 5).coverage, {});
    assert.deepEqual(normalizeResults({ results: [], coverage: "searched" }, 5).coverage, {});
    assert.deepEqual(normalizeResults({ results: [], coverage: null }, 5).coverage, {});
    assert.deepEqual(normalizeResults({ coverage: { main: "searched" } }, 5), { results: [], warnings: [], conflicts: [], coverage: { main: "searched" } });
});

test("normalizeConfig defaults requireServiceCoverage off and accepts only true", () => {
    assert.equal(normalizeConfig({ endpoint: "http://x" }).requireServiceCoverage, false);
    assert.equal(normalizeConfig({ endpoint: "http://x", requireServiceCoverage: "yes" }).requireServiceCoverage, false);
    assert.equal(normalizeConfig({ endpoint: "http://x", requireServiceCoverage: true }).requireServiceCoverage, true);
});
