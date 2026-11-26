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

## D.3 Option C (next minor; not installed or runtime-accepted)

No `inbound_claim`, `message_sent` or mandatory `messageProvenance` dependency.
Capture and saving are separate `memory_fact_propose` / `memory_fact_confirm`
tools. Both plus `unified_memory_search` are declared in `contracts.tools`.
Feature default is off. `facts.bearerToken` is a capability-owned prepared
SecretRef (`source: exec`, `provider: secretref`, `id: MEMORY_FACTS_WRITE_TOKEN`);
missing secret fails closed. SDK export `openclaw/plugin-sdk/secret-input-runtime`
and manifest `configContracts.secretInputs` must exist in the candidate image.

### Telegram and WebChat host-context contract (2026-11-26)

Both channels use the same gates; `requesterProfileId` is optional metadata only.
Require host owner authorization, prepared owner-private audience, explicit direct
chat type, ordinary root/main/dashboard or direct-channel session, and current
external-user run context (`trigger: "user"`, `inputProvenance.kind:
"external_user"`, no `sourceRole`). Unknown type/origin denies. These are
**required adapter contracts, not invented claims about current host fields**.

Installed local OpenClaw 2026.11.4 source evidence (not upstream guarantees):

- Telegram produces `conversation.kind` as `"group"` or `"direct"` at
  `/app/dist/bot-message-HYWIRx8p.mjs:934`, passes it at line 1005;
  `/app/dist/context-B_k_S6nC.mjs:181` maps it to `ChatType`.
  `/app/dist/agent-runner-utils-FzOMyVwy.mjs:204` maps `ChatType` to runtime
  `chatType`. **It is absent** from the complete public tool-factory context
  `/app/dist/openclaw-tools-BcYM16A_.mjs:550` (object ends at line 582).
- Host authorization matches sender candidates to owner allowlists at
  `/app/dist/command-auth-DPD2ejxk.mjs:422`, computes `senderIsOwner` at line 445.
  `/app/dist/get-reply-DFYHTxys.mjs:3559` puts it in the ordinary reply run;
  `/app/dist/agent-runner-run-params-BJ1Xjo0R.mjs:174` carries it to runtime;
  `/app/dist/agent-tools-DD0_71KJ.mjs:760` spreads runtime options;
  `/app/dist/openclaw-tools-BcYM16A_.mjs:575` projects `senderIsOwner` to tools.
  Thus Telegram's host-computed owner boolean has a real delivery path, not a
  text-derived claim. Allowlisted command authorization alone is not ownership.
- `trigger` and `inputProvenance` exist on the separate prompt-hook context at
  `/app/dist/hook-context-CrfJ-FCU.mjs:26`, but **neither is projected** in that
  tool-factory object. Root session keys alone cannot exclude automated root
  continuations. Do not remove the run-context gate to work around this gap.
- Direct-session key shapes come from
  `/app/dist/session-key-CSDERtm3.mjs:484`: main (line 506), per-peer (505),
  per-channel-peer (503), per-account-channel-peer (499). Adapter accepts only
  supported WebChat/Telegram channel shapes plus root main/dashboard and direct.
- Prepared audience checks `/app/dist/memory-audience-FSMgkUKT.mjs:178` remain;
  owner-private audience is inherited by spawned descendants (lines 134–157),
  so it alone is not write authority. Do not infer directness from `isGroup: false`.
- Requester-profile carrier `/app/dist/requester-profile-u6QLGOHK.mjs:2` and its
  WebChat-only producer `/app/dist/chat-send-handler-Duf_7dlJ.mjs:2461` are no
  longer required for either channel. Profile changes do not break draft binding.
- Native forwarding starts at `/app/dist/helpers-DZ2foAlJ.mjs:461` and visible
  `ForwardedFrom` fields at `/app/dist/inbound-context-DnPzLOsP.mjs:35`; absent
  from public tool context. Any projected forwarding signal denies writes.
- Session lifecycle/reset invalidates drafts; invocation and audience currency
  guards run when provided. One-shot CLI and memory-flush runs deny.

**Runtime status: blocked on both channels** by missing tool-factory `chatType`,
`trigger`, `inputProvenance`. Static ingress-to-projection inspection establishes
that Telegram cannot currently receive all required fields; no live Telegram run
or callback trace was performed. No host/config changes, installation or restart.

### Weaker consent contract and residual risk

The agent, not an inbound hook, interprets “yes”. It must display the question and
wait for affirmative owner input in a later turn. The adapter cannot prove delivery,
new-turn timing or semantic consent, and cannot detect forwarded messages with the
current projected fields. An agent can wrongly call confirm immediately or mistake
forwarded/quoted text for consent. This is the explicitly chosen Option C residual
risk, **not** transport-attested human authorization. Optional future host
`messageProvenance: "forwarded"` denies operations. Missing provenance is allowed.

Owner account compromise = owner (Telegram and WebChat); no stronger browser-only
requester-profile requirement is imposed.

Draft ids bind to session/incarnation/sender for at most five minutes;
replays, expired and foreign ids fail locally. Backend session references use
separate random proposal/confirmation operation ids (agent assertions, not native
message ids). Confirmation consumes before request; uncertain outcomes require a
new draft, never a retry. End/retract/forget are drafts, not direct writes.

Backend: memory-sebg v1.24.0 `/facts/drafts`, `/facts/confirm`, `/facts/current`
and authenticated `/unified/search` explicit `fact_subject`/`fact_predicate`.
Automatic recall must query concrete slots: the bounded 18-predicate unkeyed
`person:owner` slice is not complete enumeration of all subjects/keyed set facts.
See README for limitations, exact config and owner acceptance steps.

Validation is synthetic HTTP mocks and source inspection only; no live facts read
or write, runtime install or per-channel acceptance. Keep disabled until the owner
merges/releases/installs and performs candidate-host and private WebChat/Telegram acceptance after genuine field projection.
