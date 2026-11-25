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

## D.3 fact lane (next minor; not installed or runtime-accepted here)

Legacy retrieval remains compatible with the prior plugin entry API. Enabling
`facts.enabled` additionally requires all of these host contracts:

- `inbound_claim`: host `senderIsOwner`, explicit `isGroup: false`, millisecond
  provider timestamp, canonical `ctx.sessionKey`, `ctx.senderId`, `ctx.messageId`,
  native `ctx.replyToId`; edits/quoted replies must be signalled.
- `message_sent`: successful delivery with canonical session, complete exact
  content and actual provider message ID. Missing WebChat/channel delivery
  support is fail-closed, **not** a simulated successful binding.
- Tool factory host `senderIsOwner`, `requesterSenderId`, `sessionId`,
  `memoryAudience.kind: "owner-private"` and canonical `sessionKey`.
- `session_start`, `session_end`, `before_reset` invalidate pending mappings.
- Public SDK `openclaw/plugin-sdk/secret-input-runtime` export
  `getPreparedPluginSecretInput`, plus manifest `configContracts.secretInputs`
  startup materialization and capability-owned fail-cold isolation. Source config
  must accept the SecretRef schema while runtime values are resolved strings.

These interfaces were inspected in the locally available OpenClaw 2026.11.4 SDK,
manifest documentation and source contract snapshots. This is **not** a live
end-to-end channel compatibility certification or a minimum-version guarantee.
Older hosts lacking the SDK subpath cannot load this candidate; do not install
without the candidate-image check. Test both WebChat and Telegram delivery/reply
metadata before enabling capture. Unsupported routes remain unavailable.
Backend requirement: memory-sebg v1.24.0, `/facts/drafts`, `/facts/confirm`,
`/facts/current` and optional authenticated `/unified/search` `current_state`.
`end`/`retract`/`forget` are drafts, not direct writes. Exact SecretRef enablement
configuration and rollout/retention caveats are in README.md.

Validation: isolated synthetic HTTP mocks only; no live facts were read/written.
No automatic personal-profile injection, cross-session/fork migration or generic
secret-detection completeness is claimed. Keep the feature off pending the
operator's per-channel acceptance and separate merge/release/install/restart.
