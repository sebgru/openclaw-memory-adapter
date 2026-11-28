/**
 * Test stand-in for `openclaw/plugin-sdk/memory-host-search`. Tests install a
 * fake host on `globalThis.__nativeMemoryHost`; without one the provider is
 * unavailable, as on a Gateway where memory-core is disabled.
 */
export async function getActiveMemoryProvider(params) {
  const host = globalThis.__nativeMemoryHost;
  if (!host) return { provider: null, error: "memory plugin unavailable" };
  return host.getActiveMemoryProvider(params);
}
