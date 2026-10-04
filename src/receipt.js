const RECEIPT_SCHEMA_VERSION = 1;
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
 */
function buildReceipt({
  turnId,
  scope,
  startedAt,
  endedAt,
  resultCount = 0,
  warnings = [],
  conflicts = [],
  truncated = false,
  error = false,
}) {
  const requestedSources = sourcesForScope(scope);
  const notSearched = KNOWN_SOURCES.filter((source) => !requestedSources.includes(source));
  const boundedConflicts = Array.isArray(conflicts) ? conflicts.slice(0, MAX_CONFLICTS).map(String) : [];

  let status;
  let searched = [];
  let absent = [];
  let unavailable = [];

  if (error) {
    status = "unavailable";
    unavailable = requestedSources;
  } else if (boundedConflicts.length > 0) {
    status = "conflicting";
    searched = requestedSources;
  } else if (resultCount > 0) {
    status = "found";
    searched = requestedSources;
  } else {
    status = "absent";
    searched = requestedSources;
    absent = requestedSources;
  }

  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    turnId: String(turnId ?? ""),
    status,
    resultCount: error ? 0 : resultCount,
    sources: { searched, absent, unavailable, notSearched },
    warnings: Array.isArray(warnings) ? warnings.slice(0, MAX_WARNINGS).map(String) : [],
    conflicts: boundedConflicts,
    truncated: Boolean(truncated),
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
 * Renders a short, model-facing notice for receipt states that do not
 * already carry injected result context (absent, unavailable, conflicting).
 * "found" receipts are represented by the existing formatted result context
 * and do not need a separate notice.
 */
function formatReceiptNotice(receipt) {
  const base = STATUS_NOTICES[receipt.status];
  if (!base) return "";
  const parts = [base];
  if (receipt.sources.notSearched.length > 0) {
    parts.push(`Not searched this turn: ${receipt.sources.notSearched.join(", ")}.`);
  }
  return parts.join(" ");
}

export { RECEIPT_SCHEMA_VERSION, buildReceipt, formatReceiptNotice, sourcesForScope };
