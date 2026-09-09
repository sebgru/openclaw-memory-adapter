import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { formatMemoryContext, searchUnified } from "./src/client.js";

const UnifiedMemorySearchParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", minLength: 1, description: "Question or terms to search for." },
    scope: { type: "string", enum: ["all", "main", "archive"], description: "Search scope; archive is explicit when selected." },
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
        const results = await searchUnified(event.prompt, config);
        const context = formatMemoryContext(results, Number.isInteger(config.maxContextLength) ? config.maxContextLength : undefined);
        return context ? { prependContext: context } : undefined;
      } catch (error) {
        api.logger.warn?.(`memory-adapter: retrieval skipped: ${String(error)}`);
        return undefined;
      }
      }, { timeoutMs: (config.timeoutMs ?? 1500) + 250 });
    api.registerTool((ctx) => ({
      name: "unified_memory_search",
      label: "Unified Memory Search",
      description: "Search authoritative memory, output metadata, and optionally the session archive through the external memory service.",
      parameters: UnifiedMemorySearchParameters,
      execute: async (_toolCallId, params) => {
        const scope = params.scope ?? config.scope ?? "all";
        const results = await searchUnified(params.query, { ...config, scope, maxResults: params.maxResults ?? config.maxResults });
        return {
          content: [{
            type: "text",
            text: results.length === 0 ? "No memory results." : formatMemoryContext(results),
          }],
          details: { scope, results },
        };
      },
    }), { name: "unified_memory_search" });
  },
});
