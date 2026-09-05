import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { formatMemoryContext, searchMemory } from "./src/client.js";

function listAllows(list, value) {
  return !Array.isArray(list) || list.length === 0 || (value && list.includes(value));
}

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
  register(api) {
    const config = api.pluginConfig ?? {};
    api.on("before_prompt_build", async (event, ctx) => {
      if (!eligible(event, ctx, config)) return undefined;
      try {
        const results = await searchMemory(event.prompt, config);
        const context = formatMemoryContext(results);
        return context ? { prependContext: context } : undefined;
      } catch (error) {
        api.logger.warn?.(`memory-adapter: retrieval skipped: ${String(error)}`);
        return undefined;
      }
    }, { timeoutMs: (config.timeoutMs ?? 1500) + 250 });
  },
});
