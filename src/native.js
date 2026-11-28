/**
 * Optional routing of curated memory, notes and session recall to the native
 * OpenClaw memory provider (memory-core), next to the external memory service.
 *
 * Everything here is inert unless `nativeRouting.enabled` is `true`.
 *
 * Native access goes through the host's provider-neutral memory lease
 * (`getActiveMemoryProvider` from `openclaw/plugin-sdk/memory-host-search`).
 * The lease is opened with the calling turn's session authority and the
 * host-minted memory audience from the hook/tool context; this adapter never
 * constructs or widens authority itself, so session-transcript hits are
 * filtered by the selected memory plugin exactly as for its own tools.
 */

const DEFAULT_LOW_CONFIDENCE_SCORE = 0.35;
const DEFAULT_NATIVE_TIMEOUT_MS = 2500;
const MAX_NATIVE_TIMEOUT_MS = 6000;
const VALID_NATIVE_SOURCES = ["memory", "sessions"];
const VALID_PROMPT_SERVICE_SCOPES = ["none", "main", "all"];
const MAX_PROVENANCE_LENGTH = 256;
const MAX_RESULT_TEXT_LENGTH = 2000;
/** Paths the native index owns; service copies of them are dropped unless both lanes are wanted. */
const NATIVE_OWNED_PATH = /^(?:memory\/|MEMORY\.md$|sessions\/)/;

export const NATIVE_LOW_CONFIDENCE_NOTICE =
  "Native memory results for this turn scored below the configured confidence threshold, so they are probably not relevant. Treat them as weak hints, do not present them as facts, and do not read them as a verified absence or a retrieval failure.";
export const NATIVE_UNAVAILABLE_NOTICE =
  "Native memory (notes, curated memory, sessions) was unavailable for this turn; other memory sources may still have been searched. Do not claim that no matching note exists.";
export const NATIVE_UNAVAILABLE_WARNING = "native memory unavailable";

/**
 * Normalizes the `nativeRouting` plugin config. `enabled` defaults to false;
 * every other field only matters when it is true.
 */
export function nativeRoutingSettings(raw) {
  const config = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const sources = Array.isArray(config.sources)
    ? [...new Set(config.sources.filter((source) => VALID_NATIVE_SOURCES.includes(source)))]
    : [];
  const score = Number(config.lowConfidenceScore);
  return {
    enabled: config.enabled === true,
    sources: sources.length ? sources : ["memory"],
    lowConfidenceScore: Number.isFinite(score) && score >= 0 && score <= 1 ? score : DEFAULT_LOW_CONFIDENCE_SCORE,
    timeoutMs: Number.isInteger(config.timeoutMs)
      ? Math.min(Math.max(config.timeoutMs, 250), MAX_NATIVE_TIMEOUT_MS)
      : DEFAULT_NATIVE_TIMEOUT_MS,
    promptServiceScope: VALID_PROMPT_SERVICE_SCOPES.includes(config.promptServiceScope)
      ? config.promptServiceScope
      : "none",
  };
}

const IDENTIFIER_PATTERNS = [
  // snake_case or dotted machine identifiers: sensor.energy_daily_cost, foo_bar
  /(?<![\p{L}\p{N}])[\p{L}\p{N}]+(?:[._][\p{L}\p{N}]+)*_[\p{L}\p{N}_.]+/u,
  /(?<![\p{L}\p{N}])\p{L}+\.\p{L}+_[\p{L}\p{N}_.]*/u,
  // ticket/case codes such as X-02, MSR-12, E.3, #24
  /(?<![\p{L}\p{N}])\p{Lu}{1,6}[-.]\d{1,5}(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}&])#\d{1,6}(?![\p{L}\p{N}])/u,
  // versions and commit hashes
  /(?<![\p{L}\p{N}])v?\d+\.\d+\.\d+(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\p{L}\p{N}])/u,
  // e-mail addresses, paths with an extension, owner/repo
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/u,
  /(?:^|[\s("'`])(?:[\w.-]+\/)*[\w-]+\.(?:md|json|ya?ml|js|mjs|ts|py|sh|txt|pdf|csv|html?)(?=$|[\s),"'`])/u,
  // mixed letter/digit tokens such as 12b, B2B-7, IBAN-like codes
  /(?<![\p{L}\p{N}])(?=[\p{L}\p{N}-]*\p{L})(?=[\p{L}\p{N}-]*\d)[\p{L}\p{N}-]{3,}(?![\p{L}\p{N}])/u,
];

/**
 * True for queries that look like exact identifiers (C.3 condition 5). The
 * lexical service lane is run next to native for these, because short exact
 * lookups favoured the service in the C.3 comparison. `shortQueryWords`
 * also treats very short explicit tool queries as lookups; the prompt hook
 * passes 0 so ordinary short chat turns do not trigger the service lane.
 */
export function isIdentifierLike(query, { shortQueryWords = 0 } = {}) {
  const text = String(query ?? "").trim().slice(0, 4000);
  if (!text) return false;
  if (IDENTIFIER_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return shortQueryWords > 0 && text.split(/\s+/).length <= shortQueryWords;
}

function cleanText(value, max) {
  return String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Converts provider-neutral hits into the adapter's result entries. */
export function normalizeNativeHits(hits, maxResults, maxResultTextLength = MAX_RESULT_TEXT_LENGTH) {
  if (!Array.isArray(hits)) return [];
  return hits.flatMap((hit) => {
    if (!hit || typeof hit !== "object") return [];
    const rawText = String(hit.excerpt ?? "").trim();
    if (!rawText) return [];
    const text = rawText.length > maxResultTextLength ? `${rawText.slice(0, maxResultTextLength)}…` : rawText;
    const path = cleanText(hit.reference?.id, MAX_PROVENANCE_LENGTH);
    const citation = Array.isArray(hit.citations) ? hit.citations[0] : undefined;
    const line = Number.isInteger(citation?.startLine) && citation.startLine >= 0 ? citation.startLine : undefined;
    const corpus = hit.source === "sessions" ? "sessions" : "memory";
    const score = Number.isFinite(Number(hit.score)) ? Number(hit.score) : undefined;
    const fragment = cleanText(hit.reference?.fragment, 64);
    return [{
      text,
      source: `native-${corpus}`,
      score,
      lane: "native",
      ...(path ? { id: `native:${path}${fragment ? `#${fragment}` : ""}`, path } : {}),
      ...(line !== undefined ? { line } : {}),
      provenance: {
        source: `native-${corpus}`,
        ...(path ? { path } : {}),
        ...(line !== undefined ? { line } : {}),
      },
    }];
  }).slice(0, maxResults);
}

/**
 * Native emits no low-confidence signal (C.3 condition 2). A result set is
 * low confidence when it is non-empty and its best score is below the
 * threshold. A missing score counts as unknown, not as weak. The default
 * 0.35 comes from 20 C.3 cases (no-match top-1 0.22/0.32 vs lowest relevant
 * top-1 0.35) and still needs validation on a larger no-match set.
 */
export function isNativeLowConfidence(results, threshold) {
  if (!Array.isArray(results) || results.length === 0 || !(threshold > 0)) return false;
  const scores = results.map((result) => result.score).filter((score) => Number.isFinite(score));
  if (scores.length !== results.length) return false;
  return Math.max(...scores) < threshold;
}

function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error("native memory search timed out"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("native memory search timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

const defaultLoadHost = () => import("openclaw/plugin-sdk/memory-host-search");

/**
 * Returns `searchNative(query, options)` bound to this plugin's API. It
 * resolves `{ results, warnings, lowConfidence }` and rejects when native
 * memory is unavailable (no session authority, no provider, timeout, error).
 */
export function createNativeSearch(api, { loadHost = defaultLoadHost } = {}) {
  return async function searchNative(query, {
    ctx,
    maxResults = 5,
    timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
    sources = ["memory"],
    lowConfidenceScore = DEFAULT_LOW_CONFIDENCE_SCORE,
    maxQueryLength = 4000,
    maxResultTextLength = MAX_RESULT_TEXT_LENGTH,
    signal: parentSignal,
  } = {}) {
    const boundedQuery = String(query ?? "").trim().slice(0, maxQueryLength);
    if (!boundedQuery) throw new Error("memory query must not be empty");
    // Fail closed: without the turn's own session there is no authority to
    // borrow, and host/operator authority would widen access.
    if (typeof ctx?.sessionKey !== "string" || !ctx.sessionKey) {
      throw new Error("native memory search requires session authority");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromParent = () => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    let provider;
    try {
      const host = await raceAbort(Promise.resolve().then(loadHost), controller.signal);
      if (typeof host?.getActiveMemoryProvider !== "function") {
        throw new Error("native memory provider API unavailable on this host");
      }
      const cfg = api.runtime?.config?.current?.() ?? api.config;
      const context = {
        authority: {
          kind: "session",
          sessionKey: ctx.sessionKey,
          ...(typeof ctx.sessionId === "string" && ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          sandboxed: ctx.sandboxed === true,
          ...(ctx.memoryAudience ? { audience: ctx.memoryAudience } : {}),
        },
        signal: controller.signal,
        assertCurrent: () => {
          if (typeof ctx.assertMemoryAudienceCurrent === "function") ctx.assertMemoryAudienceCurrent();
        },
      };
      const opened = await raceAbort(
        host.getActiveMemoryProvider({ cfg, agentId: ctx.agentId || "main", context }),
        controller.signal,
      );
      provider = opened?.provider;
      if (!provider) throw new Error("native memory provider unavailable");
      const supported = Array.isArray(provider.capabilities?.sources) ? provider.capabilities.sources : ["memory"];
      const requested = sources.filter((source) => supported.includes(source));
      if (!requested.length) throw new Error("native memory provider does not serve the requested sources");
      const page = await raceAbort(provider.search({
        query: boundedQuery,
        maxResults,
        minScore: 0,
        sources: requested,
      }), controller.signal);
      const results = normalizeNativeHits(page?.hits, maxResults, maxResultTextLength);
      const warnings = [];
      if (page?.coverage === "partial" || typeof page?.warning === "string") warnings.push("native: index coverage partial");
      return {
        results,
        warnings,
        lowConfidence: isNativeLowConfidence(results, lowConfidenceScore),
      };
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
      if (provider && typeof provider.close === "function") {
        try { await provider.close(); } catch { /* lease cleanup is best effort */ }
      }
    }
  };
}

function identityOf(item) {
  if (item.path) return `${item.path}:${Number.isInteger(item.line) ? item.line : ""}`;
  return undefined;
}

/**
 * Merges the native lane with the external service lane. Native entries and
 * service entries alternate (scores are not comparable across engines), the
 * native lane leading. Service copies of native-owned paths (curated memory,
 * notes, sessions) are dropped unless `keepServiceCopies` is set for
 * identifier-like queries, where the lexical service lane may hold the only
 * exact hit; exact path/line duplicates are always collapsed.
 */
export function mergeRoutedResults(nativeResults, serviceResults, maxResults, { keepServiceCopies = false } = {}) {
  const service = (serviceResults ?? []).filter((item) =>
    keepServiceCopies || !(item.path && NATIVE_OWNED_PATH.test(item.path)));
  const merged = [];
  const seen = new Set();
  const push = (item) => {
    const identity = identityOf(item);
    if (identity && seen.has(identity)) return;
    if (identity) seen.add(identity);
    merged.push(item);
  };
  const nativeQueue = [...(nativeResults ?? [])];
  const serviceQueue = [...service];
  while (merged.length < maxResults && (nativeQueue.length || serviceQueue.length)) {
    if (nativeQueue.length) push(nativeQueue.shift());
    if (merged.length < maxResults && serviceQueue.length) push(serviceQueue.shift());
  }
  return merged.slice(0, maxResults);
}

export { DEFAULT_LOW_CONFIDENCE_SCORE, NATIVE_OWNED_PATH };
