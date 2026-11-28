import { NATIVE_UNAVAILABLE_WARNING, isIdentifierLike, mergeRoutedResults } from "./native.js";

/** Explicit tool queries of at most this many words count as exact lookups. */
const TOOL_SHORT_QUERY_WORDS = 3;

export const ROUTED_LOW_CONFIDENCE_NOTICE =
  "Memory results for this turn are low confidence (native memory scored below the confidence threshold and/or the memory service reported no lexical match and only weak similarity), so they are probably not relevant. Treat them as weak hints, do not present them as facts, and do not read them as a verified absence or a retrieval failure.";

const SOURCES = ["main", "archive", "documents"];

function coverageFor(states) {
  return Object.fromEntries(SOURCES.map((source) => [source, states[source] ?? "not_searched"]));
}

/** Requested receipt sources: those a lane was actually asked to search. */
export function requestedSources(coverage) {
  if (!coverage || typeof coverage !== "object") return undefined;
  const sources = SOURCES.filter((source) => coverage[source] && coverage[source] !== "not_searched");
  return sources.length ? sources : undefined;
}

/**
 * Combines a native lane outcome with an optional service lane outcome.
 * `native` / `service` are `{ response }` or `{ failed: true }`; `service`
 * may be undefined when no service lane ran.
 */
function combine({ native, service, serviceScope, maxResults, identifierLike }) {
  const nativeOk = Boolean(native?.response);
  const serviceOk = Boolean(service?.response);
  if (!nativeOk && !serviceOk) throw new Error("all memory lanes unavailable");
  const nativeResponse = native?.response ?? { results: [], warnings: [] };
  const serviceResponse = service?.response ?? { results: [], warnings: [] };
  // Service copies of notes stay when native failed (fallback) or for exact
  // identifiers, where the lexical lane may hold the only exact hit.
  const results = mergeRoutedResults(
    nativeResponse.results,
    serviceResponse.results,
    maxResults,
    { keepServiceCopies: identifierLike || !nativeOk },
  );
  const warnings = [...new Set([
    ...(nativeOk ? nativeResponse.warnings ?? [] : [NATIVE_UNAVAILABLE_WARNING]),
    ...(serviceResponse.warnings ?? []),
    ...(service?.failed ? ["memory service lane unavailable"] : []),
  ])];
  const conflicts = [...(serviceResponse.conflicts ?? [])];

  let coverage;
  if (nativeOk && (!service || serviceOk)) {
    const serviceCoverage = serviceOk ? serviceResponse.coverage : undefined;
    if (serviceOk && serviceCoverage === undefined) {
      coverage = undefined; // service did not report coverage: stay unknown
    } else {
      const states = { main: "searched" };
      if (serviceOk) {
        for (const source of SOURCES) {
          const state = serviceCoverage?.[source];
          if (source === "main") {
            if (serviceScope && ["all", "main"].includes(serviceScope) && state !== "searched") states.main = state ?? "unavailable";
          } else if (state && (serviceScope === "all" || serviceScope === source)) {
            states[source] = state;
          }
        }
      }
      coverage = coverageFor(states);
    }
  }
  // A failed lane never yields a verified coverage map.

  const nativeWeak = !nativeOk || nativeResponse.results.length === 0 || nativeResponse.lowConfidence === true;
  const serviceUsed = results.some((item) => item.lane !== "native");
  const serviceWeak = !serviceUsed || serviceResponse.lowConfidence === true;
  const nativeUsed = results.some((item) => item.lane === "native");
  const lowConfidence = results.length > 0 && (nativeUsed || serviceUsed) && nativeWeak && serviceWeak;
  return {
    results,
    warnings,
    conflicts,
    ...(coverage ? { coverage } : {}),
    ...(lowConfidence ? { lowConfidence: true } : {}),
    nativeUnavailable: !nativeOk,
  };
}

const settle = (promise) => promise.then((response) => ({ response }), () => ({ failed: true }));

/**
 * `unified_memory_search` with native routing on. Returns undefined when the
 * scope belongs to the service alone (documents, archive), so the caller
 * keeps the unchanged service path.
 */
export async function routedToolSearch({ query, scope, ctx, config, settings, searchNative, searchService }) {
  if (scope !== "all" && scope !== "main") return undefined;
  const maxResults = Number.isInteger(config.maxResults) ? config.maxResults : 5;
  const identifierLike = isIdentifierLike(query, { shortQueryWords: TOOL_SHORT_QUERY_WORDS });
  // The service keeps outputs/projects (main) plus documents/archive (all).
  const [native, service] = await Promise.all([
    settle(searchNative(query, {
      ctx,
      maxResults,
      timeoutMs: settings.timeoutMs,
      sources: settings.sources,
      lowConfidenceScore: settings.lowConfidenceScore,
      maxQueryLength: config.maxQueryLength,
      maxResultTextLength: config.maxResultTextLength,
    })),
    settle(searchService(query, { ...config, scope, profile: "tool", maxResults })),
  ]);
  return { ...combine({ native, service, serviceScope: scope, maxResults, identifierLike }), identifierLike };
}

/**
 * Prompt-hook baseline with native routing on. Native always runs; the
 * service runs only for identifier-like prompts (scope main), when
 * `promptServiceScope` asks for it, or as a fallback when native fails. It
 * never runs a service scope=all search on every turn unless configured.
 */
export async function routedPromptBaseline({ prompt, ctx, config, settings, searchNative, searchService, timeoutMs }) {
  const maxResults = Number.isInteger(config.maxResults) ? config.maxResults : 5;
  const identifierLike = isIdentifierLike(prompt, { shortQueryWords: 0 });
  const configuredScope = settings.promptServiceScope === "none" ? undefined : settings.promptServiceScope;
  const serviceScope = configuredScope ?? (identifierLike ? "main" : undefined);
  const startedAt = Date.now();
  const serviceLane = serviceScope
    ? settle(searchService(prompt, { ...config, scope: serviceScope, profile: "prompt", timeoutMs }))
    : undefined;
  const native = await settle(searchNative(prompt, {
    ctx,
    maxResults,
    timeoutMs: Math.min(settings.timeoutMs, timeoutMs),
    sources: settings.sources,
    lowConfidenceScore: settings.lowConfidenceScore,
    maxQueryLength: config.maxQueryLength,
    maxResultTextLength: config.maxResultTextLength,
  }));
  let service = await serviceLane;
  let effectiveScope = serviceScope;
  if (native.failed && !service?.response) {
    // Fallback keeps notes reachable through the service's copy of memory/.
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs >= 250) {
      service = await settle(searchService(prompt, { ...config, scope: "main", profile: "prompt", timeoutMs: remainingMs }));
      effectiveScope = "main";
    }
  }
  return {
    ...combine({ native, service, serviceScope: effectiveScope, maxResults, identifierLike }),
    identifierLike,
    serviceScope: effectiveScope,
  };
}
