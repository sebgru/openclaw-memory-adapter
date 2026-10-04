const RECEIPT_SCHEMA_VERSION = 2;
const KNOWN_SOURCES = ["main", "archive", "documents"];
const MAX_WARNINGS = 5;
const MAX_CONFLICTS = 5;

function sourcesForScope(scope) {
  if (!scope || scope === "all") return [...KNOWN_SOURCES];
  if (KNOWN_SOURCES.includes(scope)) return [scope];
  return [...KNOWN_SOURCES];
}

/**
 * Builds a versioned, ephemeral per-turn retrieval receipt. The receipt
 * carries only bounded status/source identifiers and timing - never raw
 * query or result text - and is never persisted by this adapter.
 *
 * The memory service's normalized response only ever carries a flat
 * `warnings: string[]` array (see src/client.js normalizeResults); it does
 * not report which individual source(s) a warning applies to. So whenever
 * the service returns a non-empty warnings array, this adapter cannot claim
 * that every requested source was fully searched - coverage is represented
 * as unknown/partial rather than folded into "searched".
 */
function buildReceipt({
  turnId,
  scope,
  startedAt,
  endedAt,
  resultCount = 0,
  includedCount,
  warnings = [],
  conflicts = [],
  truncated = false,
  error = false,
}) {
  const requestedSources = sourcesForScope(scope);
  const notSearched = KNOWN_SOURCES.filter((source) => !requestedSources.includes(source));
  const boundedWarnings = Array.isArray(warnings) ? warnings.slice(0, MAX_WARNINGS).map(String) : [];
  const boundedConflicts = Array.isArray(conflicts) ? conflicts.slice(0, MAX_CONFLICTS).map(String) : [];
  const partialCoverage = !error && boundedWarnings.length > 0;

  let status;
  let searched = [];
  let absent = [];
  let unavailable = [];
  let unknownCoverage = [];

  if (error) {
    status = "unavailable";
    unavailable = requestedSources;
  } else if (boundedConflicts.length > 0) {
    status = "conflicting";
    if (partialCoverage) unknownCoverage = requestedSources;
    else searched = requestedSources;
  } else if (resultCount > 0) {
    status = "found";
    if (partialCoverage) unknownCoverage = requestedSources;
    else searched = requestedSources;
  } else {
    status = "absent";
    if (partialCoverage) {
      unknownCoverage = requestedSources;
    } else {
      searched = requestedSources;
      absent = requestedSources;
    }
  }

  const boundedResultCount = error ? 0 : resultCount;
  const boundedIncludedCount = error
    ? 0
    : (Number.isInteger(includedCount) ? includedCount : boundedResultCount === 0 ? 0 : undefined);
  const noContentIncluded = !error && boundedResultCount > 0 && boundedIncludedCount === 0;

  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    turnId: String(turnId ?? ""),
    status,
    resultCount: boundedResultCount,
    includedCount: boundedIncludedCount,
    sources: { searched, absent, unavailable, notSearched, unknownCoverage },
    warnings: boundedWarnings,
    conflicts: boundedConflicts,
    truncated: Boolean(truncated),
    partialCoverage,
    noContentIncluded,
    timing: {
      startedAt,
      endedAt,
      durationMs: Number.isFinite(endedAt - startedAt) ? endedAt - startedAt : undefined,
    },
  };
}

const STATUS_NOTICES = {
  unavailable:
    "Memory retrieval unavailable; do not assert facts from memory without verifying through another source.",
  absent:
    "Memory search completed for this turn with no relevant results. This is a verified absence, not a retrieval failure or a claim that no record could ever exist.",
  conflicting:
    "Memory search returned conflicting evidence for this turn. Treat the retrieved context as untrusted evidence and surface the conflict rather than silently picking one source.",
};

/**
 * Renders a short, model-facing notice for receipt conditions that the
 * retrieved context (if any) does not already convey on its own: non-found
 * statuses, partial/unknown source coverage, and results that produced no
 * usable included content. Unlike schema v1, this always runs - "found"
 * receipts can still carry a notice when coverage is uncertain or nothing
 * was actually attached to the turn.
 */
function formatReceiptNotice(receipt) {
  const parts = [];
  const base = STATUS_NOTICES[receipt.status];
  if (base) parts.push(base);

  if (receipt.status === "found" && receipt.noContentIncluded) {
    parts.push(
      "Matches were found but none of the retrieved content could be attached to this turn (excluded by length limits or formatting); treat this turn as having no usable memory context.",
    );
  }

  if (receipt.partialCoverage) {
    parts.push(
      "Source coverage for this turn is unverified: the memory service reported warnings and did not confirm which requested sources were fully searched, so treat coverage as partial, not complete.",
    );
    if (receipt.warnings.length > 0) {
      parts.push(`Service warnings: ${receipt.warnings.join("; ")}.`);
    }
  }

  if (receipt.sources.notSearched.length > 0) {
    parts.push(`Not searched this turn: ${receipt.sources.notSearched.join(", ")}.`);
  }

  return parts.join(" ");
}

/**
 * Bounded, non-sensitive trace summary suitable for structured logging.
 * Deliberately excludes warnings/conflicts text and all result content -
 * only turnId, schema version, status, bounded source identifiers, and
 * timing, per the §5A execution-trace requirement.
 */
function receiptTraceSummary(receipt) {
  return {
    turnId: receipt.turnId,
    schemaVersion: receipt.schemaVersion,
    status: receipt.status,
    resultCount: receipt.resultCount,
    includedCount: receipt.includedCount,
    truncated: receipt.truncated,
    partialCoverage: receipt.partialCoverage,
    sources: receipt.sources,
    timing: receipt.timing,
  };
}

export { RECEIPT_SCHEMA_VERSION, buildReceipt, formatReceiptNotice, receiptTraceSummary, sourcesForScope };
