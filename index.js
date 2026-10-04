import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildMemoryContextDetails, formatMemoryContext, searchUnified } from "./src/client.js";
import { buildReceipt, formatReceiptNotice, receiptTraceSummary } from "./src/receipt.js";

const FAILURE_NOTICE = "Memory retrieval unavailable; do not assert facts from memory without verifying through another source.";

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

export { eligible, listAllows };

function eligible(event, ctx, config) {
  if (config.enabled === false) return false;
  if (!listAllows(config.agents, ctx.agentId)) return false;
  if (!listAllows(config.allowedChatTypes, ctx.chatType)) return false;
  if (!listAllows(config.allowedChatIds, ctx.chatId)) return false;
  return typeof event?.prompt === "string" && event.prompt.trim().length > 0;
}

export default definePluginEntry({
  id: "memory-adapter",
  name: "External Memory Adapter",
  description: "Adds bounded external memory retrieval without invoking indexing.",
  contracts: { tools: ["unified_memory_search"] },
  register(api) {
    const config = api.pluginConfig ?? {};
    api.on("before_prompt_build", async (event, ctx) => {
      if (!eligible(event, ctx, config)) return undefined;
      const turnReceipts = config.turnReceipts === true;
      const scope = "all";
      const turnId = turnReceipts ? nextTurnId(event, ctx) : undefined;
      const startedAt = turnReceipts ? Date.now() : undefined;
      try {
        const { results, warnings, conflicts } = await searchUnified(event.prompt, { ...config, scope, profile: "prompt" });
        if (warnings?.length) {
          api.logger.warn?.(`memory-adapter: service reported ${warnings.length} warning(s); details omitted`);
        }
        const maxContextLength = Number.isInteger(config.maxContextLength) ? config.maxContextLength : undefined;
        if (!turnReceipts) {
          const context = formatMemoryContext(results, maxContextLength);
          return context ? { prependContext: context } : undefined;
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
          truncated,
        });
        logReceiptTrace(api, receipt);
        const notice = formatReceiptNotice(receipt);
        const hasUsableContext = includedCount > 0;
        const prependContext = [hasUsableContext ? context : "", notice].filter(Boolean).join("\n\n");
        return { prependContext };
      } catch (error) {
        api.logger.warn?.(`memory-adapter: retrieval failed: ${String(error)}`);
        if (!turnReceipts) {
          return { prependContext: FAILURE_NOTICE };
        }
        const receipt = buildReceipt({ turnId, scope, startedAt, endedAt: Date.now(), error: true });
        logReceiptTrace(api, receipt);
        return { prependContext: formatReceiptNotice(receipt) };
      }
    }, { timeoutMs: (config.timeoutMs ?? 1500) + 250 });
    api.registerTool((_ctx) => ({
      name: "unified_memory_search",
      label: "Unified Memory Search",
      description: "Search authoritative memory, output metadata, indexed documents, and the session archive through the external memory service.",
      parameters: UnifiedMemorySearchParameters,
      execute: async (_toolCallId, params) => {
        const scope = params.scope ?? config.scope ?? "all";
        try {
          const { results, warnings, conflicts } = await searchUnified(params.query, { ...config, scope, profile: "tool", maxResults: params.maxResults ?? config.maxResults });
          const textParts = [];
          if (results.length === 0) {
            textParts.push("No memory results.");
          } else {
            textParts.push(formatMemoryContext(results));
          }
          if (warnings?.length) {
            textParts.push(`Warnings: ${warnings.slice(0, 3).join("; ")}`);
          }
          return {
            content: [{ type: "text", text: textParts.join("\n") }],
            details: { scope, results, warnings, conflicts },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: FAILURE_NOTICE }],
            details: { scope, error: String(error) },
          };
        }
      },
    }), { name: "unified_memory_search" });
  },
});
