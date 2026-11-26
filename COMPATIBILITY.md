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

### Inspected host fields (local OpenClaw 2026.11.4, not upstream guarantees)

- `/app/dist/openclaw-tools-BcYM16A_.mjs:549` builds tool context; lines 570–580
  project message channel, delivery context, requester sender/profile, owner,
  prepared memory audience/currentness and conversation read policy. There is no
  direct `ChatType`, spawned-by, run-kind or current input provenance field here.
- `/app/dist/requester-profile-u6QLGOHK.mjs:2` defines the host-only Symbol/private
  carrier; lines 19–22 check channel/sender binding and live profile currency.
  `/app/dist/chat-send-handler-Duf_7dlJ.mjs:2461` binds it only for authenticated
  browser UI callers, excluding synthetic clients and nonexternal input provenance.
  `/app/dist/agent-runner-utils-FzOMyVwy.mjs:219` reads that carrier;
  `/app/dist/agent-tools-DD0_71KJ.mjs:769` forwards its id into tool context.
  JSON/text/model parameters cannot mint this carrier.
- `memoryAudience` is prepared and session-bound, checked by
  `/app/dist/memory-audience-FSMgkUKT.mjs:178`. Root direct owner-private access
  is decided at lines 134–157 but inherited down spawned-by lineage: **audience
  alone is not write authority**. Group roots do not qualify. Combine it with
  owner, browser-only current profile, webchat channel, ordinary root session-key
  allowlist, sender and incarnation; unknown/missing fields deny writes.
- `conversationReadOrigin` (`/app/dist/conversation-read-origin-E3olMOwo.mjs:2`)
  is a read policy label, defaults to delegated and is not a human-input test.
  We do not use it or infer directness from `isGroup: false`.
- Subagent/cron session keys are outside the allowed root/main/dashboard shapes.
  Cron/heartbeat/inter-session continuations of a root do not carry a freshly bound
  browser profile. This restriction depends on the inspected local requester-profile
  producer, not names/roles in prompts. Telegram has no such projected profile and
  fails closed for writes. Do not invent missing tool-context fields in config.
- `session_start`, `session_end`, `before_reset` invalidate pending drafts and
  in-flight operations. Current invocation and audience guards are used when provided.

### Weaker consent contract and residual risk

The agent, not an inbound hook, interprets “yes”. It must display the question and
wait for affirmative owner input in a later turn. The adapter cannot prove delivery,
new-turn timing or semantic consent, and cannot detect forwarded messages with the
current projected fields. An agent can wrongly call confirm immediately or mistake
forwarded/quoted text for consent. This is the explicitly chosen Option C residual
risk, **not** transport-attested human authorization. Optional future host
`messageProvenance: "forwarded"` denies operations. Missing provenance is allowed.

Draft ids bind to session/incarnation/sender/profile for at most five minutes;
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
merges/releases/installs and performs candidate-host and private WebChat acceptance.
