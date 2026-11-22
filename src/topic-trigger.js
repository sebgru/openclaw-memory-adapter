import { DEFAULT_LEXICON } from "./topic-lexicon.js";
import { mergeResponseMetadata } from "./entity-query.js";

const MAX_TEXT_LENGTH = 4000;
const MAX_TERM_LENGTH = 64;
const MAX_TERMS_PER_CATEGORY = 200;
const DEFAULT_DOCUMENT_SLOTS = 2;
const MAX_DOCUMENT_SLOTS = 10;
const MIN_TIMEOUT_MS = 250;
const CATEGORY_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const WORD = "[\\p{L}\\p{N}]";

/**
 * Case-, diacritic- and umlaut-digraph-insensitive form used on both the
 * lexicon and the prompt, so "Kündigung", "Kuendigung" and "kundigung" meet.
 */
export function foldText(value) {
  return String(value)
    .toLowerCase()
    .replaceAll("’", "'")
    .replaceAll("ß", "ss")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/ae|oe|ue/g, (digraph) => digraph[0]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termPattern(raw, { possessive = false } = {}) {
  if (typeof raw !== "string") return undefined;
  const folded = foldText(raw).trim().replace(/\s+/g, " ");
  const before = folded.startsWith("*");
  const after = folded.endsWith("*");
  const core = folded.replace(/\*/g, "").trim();
  if (core.length < 2 || core.length > MAX_TERM_LENGTH) return undefined;
  const body = escapeRegExp(core).replace(/ /g, "\\s+");
  const suffix = after ? `${WORD}*` : possessive ? "(?:'?s)?" : "";
  return `${before ? `${WORD}*` : ""}${body}${suffix}`;
}

function recordOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function patternsFor(list, options) {
  return (Array.isArray(list) ? list : [])
    .slice(0, MAX_TERMS_PER_CATEGORY)
    .flatMap((raw) => termPattern(raw, options) ?? []);
}

/**
 * Compile a detector from the default lexicon plus plugin configuration.
 * `extraTerms` and `entityAliases` map a category name to a list of terms;
 * unknown category names become custom categories. Detection returns category
 * names only, never the matched text.
 */
export function createTopicDetector(topicConfig) {
  const config = recordOf(topicConfig);
  const disabled = new Set(Array.isArray(config.disabledCategories) ? config.disabledCategories : []);
  const extraTerms = recordOf(config.extraTerms);
  const entityAliases = recordOf(config.entityAliases);
  const names = [...new Set([
    ...Object.keys(DEFAULT_LEXICON),
    ...Object.keys(extraTerms),
    ...Object.keys(entityAliases),
  ])].filter((name) => CATEGORY_NAME.test(name) && !disabled.has(name));
  const matchers = names.flatMap((name) => {
    const alternatives = [
      ...patternsFor(DEFAULT_LEXICON[name]),
      ...patternsFor(extraTerms[name]),
      ...patternsFor(entityAliases[name], { possessive: true }),
    ];
    if (!alternatives.length) return [];
    const regex = new RegExp(`(?<!${WORD})(?:${alternatives.join("|")})(?!${WORD})`, "u");
    return [{ name, regex }];
  });
  return (prompt) => {
    const text = foldText(String(prompt ?? "").slice(0, MAX_TEXT_LENGTH));
    return matchers.filter(({ regex }) => regex.test(text)).map(({ name }) => name);
  };
}

const detectors = new WeakMap();
const defaultDetector = createTopicDetector(undefined);

/** Category names triggered by the prompt; memoized per configuration object. */
export function detectTopics(prompt, topicConfig) {
  if (!topicConfig || typeof topicConfig !== "object") return defaultDetector(prompt);
  if (!detectors.has(topicConfig)) detectors.set(topicConfig, createTopicDetector(topicConfig));
  return detectors.get(topicConfig)(prompt);
}

export function topicTriggerSettings(topicConfig) {
  const config = recordOf(topicConfig);
  const slots = config.documentSlots;
  return {
    enabled: config.enabled !== false,
    documentSlots: Number.isInteger(slots) && slots >= 1 && slots <= MAX_DOCUMENT_SLOTS
      ? slots
      : DEFAULT_DOCUMENT_SLOTS,
    timeoutMs: Number.isInteger(config.timeoutMs) && config.timeoutMs >= MIN_TIMEOUT_MS
      ? config.timeoutMs
      : undefined,
  };
}

function resultIdentity(item) {
  if (item?.id) return `id:${item.id}`;
  if (item?.path && Number.isInteger(item.line)) {
    return `location:${JSON.stringify([item.source, item.path, item.line])}`;
  }
  return `text:${item?.text}`;
}

/**
 * Merge documents-lane results into the baseline set. At least `documentSlots`
 * distinct documents (baseline documents count first, then the lane's own
 * order) are guaranteed in the output, bounded by `maxResults` and by the
 * documents actually available. Baseline documents that count towards the
 * reservation are never evicted; the remaining capacity keeps baseline entries
 * in rank order and then fills with further lane documents. Retained baseline
 * entries keep their relative order, and lane documents follow them. Documents
 * repeated within the lane or already in the baseline are not counted twice.
 * Entries matching `protect` (evidence from the entity follow-up) are also
 * never evicted; they take precedence over lane documents but not over
 * baseline documents counted towards the reservation.
 * Low confidence survives only when the documents lane added nothing or was
 * flagged too.
 */
export function mergeDocumentLane(baseline, documents, maxResults, documentSlots, protect = () => false) {
  const seen = new Set(baseline.results.map(resultIdentity));
  const fresh = [];
  for (const item of documents.results) {
    const identity = resultIdentity(item);
    if (seen.has(identity)) continue;
    seen.add(identity);
    fresh.push(item);
  }
  const baselineDocumentIdentities = new Set();
  const baselineDocuments = baseline.results.filter((item) => {
    if (item.source !== "document") return false;
    const identity = resultIdentity(item);
    if (baselineDocumentIdentities.has(identity)) return false;
    baselineDocumentIdentities.add(identity);
    return true;
  });
  const reservedCount = Math.min(documentSlots, maxResults, baselineDocuments.length + fresh.length);
  const reservedBaseline = new Set(baselineDocuments.slice(0, reservedCount));
  const protectedItems = new Set();
  for (const item of baseline.results) {
    if (reservedBaseline.has(item) || !protect(item)) continue;
    if (reservedBaseline.size + protectedItems.size < maxResults) protectedItems.add(item);
  }
  const kept = reservedBaseline.size + protectedItems.size;
  const reservedFresh = fresh.slice(0, Math.max(0, Math.min(reservedCount - reservedBaseline.size, maxResults - kept)));
  let capacity = maxResults - kept - reservedFresh.length;
  const retained = baseline.results.filter((item) => {
    if (reservedBaseline.has(item) || protectedItems.has(item)) return true;
    if (capacity <= 0) return false;
    capacity -= 1;
    return true;
  });
  const added = [...reservedFresh, ...fresh.slice(reservedFresh.length, reservedFresh.length + Math.max(0, capacity))];
  const { lowConfidence, ...metadata } = mergeResponseMetadata(baseline, documents);
  const keepLowConfidence = added.length ? lowConfidence : baseline.lowConfidence;
  return {
    results: [...retained, ...added],
    ...metadata,
    ...(keepLowConfidence ? { lowConfidence: true } : {}),
  };
}
