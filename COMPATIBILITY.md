# Compatibility

The adapter is an external, hook-only OpenClaw plugin. OpenClaw's documented
hook API is the compatibility boundary; bundled implementation details are
not used.

| Adapter | OpenClaw | Status |
|---|---|---|
| 0.1.x | 2026.8.x | Not runtime-tested in this repository yet |

Before a production upgrade:

1. Test the candidate OpenClaw image with the pinned adapter release.
2. Run `openclaw plugins inspect memory-adapter --runtime --json`.
3. Verify WebChat and Telegram retrieval, timeout fallback, and service outage behavior.
4. Record the result here and retain the previous OpenClaw image and adapter release.
