import { createFacts } from "./src/facts.js";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { LOW_CONFIDENCE_NOTICE, buildMemoryContextDetails, formatMemoryContext, searchUnified } from "./src/client.js";
import { buildReceipt, formatReceiptNotice, receiptTraceSummary } from "./src/receipt.js";
import { detectTopics, mergeDocumentLane, topicTriggerSettings } from "./src/topic-trigger.js";
import { expandLinkedAlias, extractEntityTarget, hasEntityEvidence, isDocumentIdentifier, mergeSearchResponses } from "./src/entity-query.js";

const FAILURE_NOTICE = "Memory retrieval unavailable; do not assert facts from memory without verifying through another source.";
const TOPIC_DOCUMENTS_NOTICE = "The focused document search for this turn's topic was unavailable; the general search still ran, so do not claim that no matching document exists.";
const TOPIC_DOCUMENTS_WARNING = "topic documents search unavailable";
const DEFAULT_TIMEOUT_MS = 1500;
const MAX_TARGETED_SEARCH_MS = 6000;

function nextTurnId(event, ctx) {
  return (
    (typeof event?.currentUserMessageId === "string" && event.currentUserMessageId) ||
    (typeof ctx?.runId === "string" && ctx.runId) ||
    globalThis.crypto.randomUUID()
  );
}

const UnifiedMemorySearchParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", minLength: 1, description: "Question or terms to search for." },
    scope: { type: "string", enum: ["all", "main", "archive", "documents"], description: "Search scope; default all. Use documents for indexed document recall." },
    maxResults: { type: "integer", minimum: 1, maximum: 10 },
    fact_subject: { type: "string", description: "Explicit private current-fact lookup subject." },
    fact_predicate: { type: "string", description: "Registry predicate for explicit private current-fact recall." },
    include_restricted: { type: "boolean", description: "Only if owner explicitly requested restricted facts." },
  },
  required: ["query"],
};

function listAllows(list, value) {
  return !Array.isArray(list) || list.length === 0 || (value && list.includes(value));
}

/**
 * Emits a bounded, non-sensitive JSON trace line for the receipt (turnId,
 * schema version, status, timing, bounded source identifiers - no raw query
 * or result text). This is the only observable execution trace: the plugin
 * API's before_prompt_build hook has no documented field for returning
 * structured metadata (only prependContext/appendContext/systemPrompt/
 * prependSystemContext/appendSystemContext/toolsAllow), so the scoped
 * plugin logger is the supported surface for making the trace available to
 * runtime acceptance/diagnostics without a parallel receipt database.
 */
function logReceiptTrace(api, receipt) {
  api.logger?.debug?.(`memory-adapter: receipt ${JSON.stringify(receiptTraceSummary(receipt))}`);
}

export { eligible, isInternalTurn, listAllows };

const INTERNAL_TRIGGERS = new Set(["heartbeat", "cron", "memory"]);
const INTERNAL_PROVENANCE_KINDS = new Set(["inter_session", "internal_system"]);

// Fail open: a missing trigger or provenance is not proof of a non-human turn.
function isInternalTurn(ctx) {
  if (INTERNAL_TRIGGERS.has(ctx?.trigger)) return true;
  return INTERNAL_PROVENANCE_KINDS.has(ctx?.inputProvenance?.kind);
}

function eligible(event, ctx, config) {
  if (config.enabled === false) return false;
  if (isInternalTurn(ctx)) return false;
  if (!listAllows(config.agents, ctx.agentId)) return false;
  if (!listAllows(config.allowedChatTypes, ctx.chatType)) return false;
  if (!listAllows(config.allowedChatIds, ctx.chatId)) return false;
  return typeof event?.prompt === "string" && event.prompt.trim().length > 0;
}

export default definePluginEntry({
  id: "memory-adapter",
  name: "External Memory Adapter",
  description: "Adds bounded external memory retrieval without invoking indexing.",
  register(api) {
    const config = api.pluginConfig ?? {};
    const facts = createFacts(api, config);
    api.on("before_prompt_build", async (event, ctx) => {
      if (!eligible(event, ctx, config)) return undefined;
      const factNoticePromise = config.facts?.enabled === true ? facts.current(ctx) : undefined;
      const turnReceipts = config.turnReceipts === true;
      const scope = "all";
      const turnId = turnReceipts ? nextTurnId(event, ctx) : undefined;
      const startedAt = turnReceipts ? Date.now() : undefined;
      const retrievalStartedAt = Date.now();
      const documentsAbort = new AbortController();
      try {
        const entityTarget = extractEntityTarget(event.prompt);
        const expandedQuery = expandLinkedAlias(event.prompt, entityTarget) ?? entityTarget;
        const targetScope = isDocumentIdentifier(entityTarget) ? "documents" : scope;
        const configuredTimeoutMs = Number.isInteger(config.timeoutMs) ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
        const boundedTimeoutMs = entityTarget
          ? Math.min(configuredTimeoutMs, MAX_TARGETED_SEARCH_MS)
          : configuredTimeoutMs;
        const topicSettings = topicTriggerSettings(config.topicTrigger);
        const topics = topicSettings.enabled ? detectTopics(event.prompt, config.topicTrigger) : [];
        // Runs in parallel with the baseline search, so it adds no wall-clock
        // time beyond the baseline timeout, and never rejects: a failed
        // documents lane degrades to a disclosed fallback.
        const documentsLane = topics.length
          ? searchUnified(event.prompt, {
            ...config,
            scope: "documents",
            profile: "prompt",
            timeoutMs: Math.min(topicSettings.timeoutMs ?? Infinity, configuredTimeoutMs, MAX_TARGETED_SEARCH_MS),
          }, undefined, { signal: documentsAbort.signal }).then((response) => ({ response }), () => ({ failed: true }))
          : undefined;
        let retrieval = await searchUnified(event.prompt, {
          ...config,
          scope,
          profile: "prompt",
          timeoutMs: boundedTimeoutMs,
        });
        const documents = await documentsLane;
        let targetedSearchUnavailable = false;
        const evidenceResults = [...retrieval.results, ...(documents?.response?.results ?? [])];
        if (entityTarget && !hasEntityEvidence(evidenceResults, entityTarget)) {
          const remainingMs = MAX_TARGETED_SEARCH_MS - (Date.now() - retrievalStartedAt);
          // Leave a small floor for the HTTP request itself; never start a
          // second request that would exceed this turn's six-second budget.
          if (remainingMs >= 250) {
            try {
              const targeted = await searchUnified(expandedQuery, {
                ...config,
                scope: targetScope,
                profile: "prompt",
                timeoutMs: Math.min(configuredTimeoutMs, remainingMs),
              });
              retrieval = mergeSearchResponses(
                retrieval,
                targeted,
                Number.isInteger(config.maxResults) ? config.maxResults : 5,
              );
            } catch {
              targetedSearchUnavailable = true;
              retrieval = {
                ...retrieval,
                coverage: undefined,
                warnings: [...new Set([
                  ...retrieval.warnings,
                  "targeted entity search unavailable",
                ])],
              };
            }
          }
        }
        if (documents?.response) {
          retrieval = mergeDocumentLane(
            retrieval,
            documents.response,
            Number.isInteger(config.maxResults) ? config.maxResults : 5,
            topicSettings.documentSlots,
            (item) => hasEntityEvidence([item], entityTarget),
          );
        } else if (documents?.failed) {
          // Coverage is dropped so receipts cannot report a verified absence
          // while the focused documents lookup was unavailable.
          retrieval = {
            ...retrieval,
            coverage: undefined,
            warnings: [...new Set([...retrieval.warnings, TOPIC_DOCUMENTS_WARNING])],
          };
        }
        if (documents) {
          api.logger.debug?.(`memory-adapter: topic documents lane ${JSON.stringify({
            topics: topics.length,
            outcome: documents.failed ? "unavailable" : "merged",
          })}`);
        }
        const factNotice = await factNoticePromise;
        const { results, warnings, conflicts, coverage, lowConfidence } = retrieval;
        if (warnings?.length) {
          api.logger.warn?.(`memory-adapter: service reported ${warnings.length} warning(s); details omitted`);
        }
        const maxContextLength = Number.isInteger(config.maxContextLength) ? config.maxContextLength : undefined;
        if (!turnReceipts) {
          const context = formatMemoryContext(results, maxContextLength);
          const entityWarning = targetedSearchUnavailable
            ? "The targeted memory search for an explicitly named entity was unavailable; do not claim that entity was absent."
            : "";
          const lowConfidenceWarning = context && lowConfidence ? LOW_CONFIDENCE_NOTICE : "";
          const topicWarning = documents?.failed ? TOPIC_DOCUMENTS_NOTICE : "";
          const prependContext = [factNotice, context, lowConfidenceWarning, entityWarning, topicWarning].filter(Boolean).join("\n\n");
          return prependContext ? { prependContext } : undefined;
        }
        const { text: context, truncated, includedCount } = buildMemoryContextDetails(results, maxContextLength);
        const receipt = buildReceipt({
          turnId,
          scope,
          startedAt,
          endedAt: Date.now(),
          resultCount: results.length,
          includedCount,
          warnings,
          conflicts,
          coverage,
          requireCoverage: config.requireServiceCoverage === true,
          truncated,
          lowConfidence,
        });
        logReceiptTrace(api, receipt);
        const notice = formatReceiptNotice(receipt);
        const hasUsableContext = includedCount > 0;
        const prependContext = [factNotice, hasUsableContext ? context : "", notice].filter(Boolean).join("\n\n");
        return { prependContext };
      } catch {
        documentsAbort.abort();
        const factNotice = await factNoticePromise;
        api.logger.warn?.("memory-adapter: retrieval failed; details omitted");
        if (!turnReceipts) {
          return { prependContext: [factNotice, FAILURE_NOTICE].filter(Boolean).join("\n\n") };
        }
        const receipt = buildReceipt({ turnId, scope, startedAt, endedAt: Date.now(), error: true });
        logReceiptTrace(api, receipt);
        return { prependContext: [factNotice, formatReceiptNotice(receipt)].filter(Boolean).join("\n\n") };
      }
    }, {
      timeoutMs: Math.max(
        Number.isInteger(config.timeoutMs) ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
        Math.min(
          MAX_TARGETED_SEARCH_MS,
          2 * (Number.isInteger(config.timeoutMs) ? config.timeoutMs : DEFAULT_TIMEOUT_MS),
        ),
      ) + 250,
    });
    api.registerTool((ctx) => ({
      name: "unified_memory_search",
      label: "Unified Memory Search",
      description: "Search authoritative memory, output metadata, indexed documents, and the session archive through the external memory service.",
      parameters: UnifiedMemorySearchParameters,
      execute: async (_toolCallId, params) => {
        if (config.facts?.enabled === true || params.fact_subject !== undefined || params.fact_predicate !== undefined) return facts.recall(ctx, params);
        const scope = params.scope ?? config.scope ?? "all";
        const turnId = (typeof _toolCallId === "string" && _toolCallId.slice(0, 128)) || globalThis.crypto.randomUUID();
        const startedAt = Date.now();
        try {
          const { results, warnings, conflicts, coverage, lowConfidence } = await searchUnified(params.query, { ...config, scope, profile: "tool", maxResults: params.maxResults ?? config.maxResults });
          const { text: context, truncated, includedCount } = buildMemoryContextDetails(results);
          const receipt = buildReceipt({
            turnId,
            scope,
            startedAt,
            endedAt: Date.now(),
            resultCount: results.length,
            includedCount,
            warnings,
            conflicts,
            coverage,
            requireCoverage: config.requireServiceCoverage === true,
            truncated,
            lowConfidence,
          });
          const textParts = [];
          if (results.length === 0) {
            textParts.push("No memory results.");
          } else {
            textParts.push(context);
            if (receipt.lowConfidence) textParts.push(LOW_CONFIDENCE_NOTICE);
          }
          if (warnings?.length) {
            textParts.push(`Warnings: ${warnings.slice(0, 3).join("; ")}`);
          }
          return {
            content: [{ type: "text", text: textParts.join("\n") }],
            details: { scope, results, warnings, conflicts, lowConfidence: receipt.lowConfidence, receipt },
          };
        } catch (error) {
          const receipt = buildReceipt({ turnId, scope, startedAt, endedAt: Date.now(), error: true });
          return {
            content: [{ type: "text", text: FAILURE_NOTICE }],
            details: { scope, error: String(error), receipt },
          };
        }
      },
    }), { name: "unified_memory_search" });
  },
});
