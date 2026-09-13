import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { formatMemoryContext, searchUnified } from "./src/client.js";

const FAILURE_NOTICE = "Memory retrieval unavailable; do not assert facts from memory without verifying through another source.";

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
      try {
        const { results, warnings } = await searchUnified(event.prompt, { ...config, scope: "all", profile: "prompt" });
        if (warnings?.length) {
          api.logger.warn?.(`memory-adapter: ${warnings.slice(0, 3).join("; ")}`);
        }
        const context = formatMemoryContext(results, Number.isInteger(config.maxContextLength) ? config.maxContextLength : undefined);
        return context ? { prependContext: context } : undefined;
      } catch (error) {
        api.logger.warn?.(`memory-adapter: retrieval failed: ${String(error)}`);
        return { prependContext: `Memory retrieval unavailable; do not assert facts from memory without verifying through another source.` };
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
          const { results, warnings } = await searchUnified(params.query, { ...config, scope, profile: "tool", maxResults: params.maxResults ?? config.maxResults });
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
            details: { scope, results, warnings },
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
