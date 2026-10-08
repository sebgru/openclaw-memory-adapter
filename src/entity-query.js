const MAX_ENTITY_QUERY_LENGTH = 160;
const COMMON_OPENERS = new Set([
  "A", "An", "And", "Are", "As", "At", "Because", "But", "Can", "Could",
  "Did", "Do", "Does", "For", "From", "Hello", "Help", "Hey", "How", "I",
  "In", "Is", "It", "Maybe", "My", "Of", "On", "Or", "Please", "Should",
  "Tell", "That", "The", "This", "To", "We", "What", "When", "Where", "Which",
  "Who", "Why", "Would", "You",
]);
const SOURCES = ["main", "archive", "documents"];

function cleanTarget(value) {
  const target = String(value).replace(/\s+/g, " ").trim();
  return target.length > 0 && target.length <= MAX_ENTITY_QUERY_LENGTH ? target : undefined;
}

/**
 * Return one high-confidence entity/identifier from the current user prompt.
 * Single unquoted first names are intentionally ignored; aliases are never
 * guessed here and must come from context or retrieved evidence.
 */
export function extractEntityTarget(prompt) {
  const text = String(prompt ?? "").slice(0, 4000);
  const candidates = [];
  const add = (index, value, priority) => {
    const target = cleanTarget(value);
    if (target) candidates.push({ index, target, priority });
  };

  const emails = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
  for (const match of text.matchAll(emails)) add(match.index, match[0], 0);

  const quoted = /["'`]([^"'`\n]{2,160})["'`]/gu;
  for (const match of text.matchAll(quoted)) add(match.index, match[1], 1);

  // A path/filename or owner/repository is a strong target. Avoid matching a
  // host/domain prefix in URLs; the slash boundary must not follow a dot.
  const paths = /(?:^|[\s("'`])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,10}|[\w.-]+\.[A-Za-z0-9]{1,10})(?=$|[\s),"'`])/gmu;
  for (const match of text.matchAll(paths)) add(match.index, match[1], 2);
  const repos = /(?<![\p{L}\p{N}_./-])([\w.-]{1,39}\/[\w.-]{1,100})(?![\w.-])/gu;
  for (const match of text.matchAll(repos)) add(match.index, match[1], 2);

  const capitalized = /\b\p{Lu}[\p{L}\p{M}'’.-]*(?:\s+\p{Lu}[\p{L}\p{M}'’.-]*){1,3}/gu;
  for (const match of text.matchAll(capitalized)) {
    const words = match[0].split(/\s+/);
    while (words.length > 1 && COMMON_OPENERS.has(words[0])) words.shift();
    if (words.length > 1) add(match.index, words.join(" "), 3);
  }

  candidates.sort((a, b) => a.index - b.index || a.priority - b.priority);
  return candidates.length ? candidates[0].target : undefined;
}

export function hasEntityEvidence(results, target) {
  const needle = String(target ?? "").toLocaleLowerCase();
  if (!needle) return false;
  return (Array.isArray(results) ? results : []).some((item) =>
    [item?.text, item?.path, item?.source]
      .some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(needle)));
}

/** Rare file/path identifiers should use the indexed-document source directly. */
export function isDocumentIdentifier(target) {
  const value = String(target ?? "");
  return !value.includes("@") && (
    value.includes("/") || /^[\w.-]+\.[A-Za-z0-9]{1,10}$/.test(value)
  );
}

function resultIdentity(item) {
  if (item?.id) return `id:${item.id}`;
  if (item?.path && Number.isInteger(item.line)) {
    return `location:${JSON.stringify([item.source, item.path, item.line])}`;
  }
  return undefined;
}

function mergeCoverage(first, second) {
  if (first === undefined && second === undefined) return undefined;
  if (!first || !second || typeof first !== "object" || typeof second !== "object") return {};
  const coverage = {};
  for (const source of SOURCES) {
    const states = [first[source], second[source]];
    if (states.includes("searched")) coverage[source] = "searched";
    else if (states.includes("unavailable")) coverage[source] = "unavailable";
    else if (states.includes("not_searched")) coverage[source] = "not_searched";
  }
  return coverage;
}

/** Merge two same-scope retrieval responses without overstating coverage. */
export function mergeSearchResponses(first, second, maxResults = 5) {
  const seen = new Set();
  const results = [...(first.results || []), ...(second.results || [])]
    .filter((item) => {
      const identity = resultIdentity(item);
      if (!identity) return true;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
    .slice(0, maxResults);
  const warnings = [...new Set([...(first.warnings ?? []), ...(second.warnings ?? [])])];
  const conflicts = [...new Set([...(first.conflicts ?? []), ...(second.conflicts ?? [])])];
  const coverage = mergeCoverage(first.coverage, second.coverage);
  return {
    results,
    warnings,
    conflicts,
    ...(coverage === undefined ? {} : { coverage }),
  };
}
