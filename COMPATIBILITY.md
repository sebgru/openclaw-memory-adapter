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

Both channels (and other channels) use the same host-projected gates:
`senderIsOwner === true`, `memoryAudience.kind === "owner-private"`, required
callable `assertMemoryAudienceCurrent`, nonempty sender/incarnation, and only root
`agent:<id>:main`, `agent:<id>:dashboard:<uuid>` or
`agent:<id>:<channel>:direct:<peer>` keys. Reserved automation channel names and
all other shapes deny. `requesterProfileId` is optional metadata only. Optional
`trigger`, `runKind`, `runType`, `inputProvenance`, `chatType`, one-shot and flush
signals deny when contrary; absent unprojected fields do not block writes.

Installed local OpenClaw 2026.11.4 source evidence (not upstream guarantees):

- **Projection:** `/app/dist/openclaw-tools-BcYM16A_.mjs:549-582` carries
  session key/id (558-559), message channel (569), sender id (573), optional local
  profile patch (574), owner (575), audience (576), flush (577), audience currency
  closure (578) and one-shot flag (581). No chatType/trigger/inputProvenance.
  Audience session binding is asserted first at line 528.
- **Audience producer:** `/app/dist/memory-audience-FSMgkUKT.mjs:90` resolves the
  admitted entry and leases its generation. Lines 151-156 mint **owner-private**
  iff durable `entry.chatType === "direct"` and sender owner is true. Lines
  159-166 mint **conversation** for other direct/group/channel entries; that value
  is denied by fact writes. Malformed/unverified/typeless sessions deny rather
  than mint owner-private. Descendant inheritance at 134-147 means audience alone
  cannot authorize writes: root-key screening is also mandatory. Currency uses
  host WeakMap records and generation leases (53-68, 256-259).
- **Both paths to audience:** `/app/dist/embedded-agent-D4DueR1g.mjs:4514-4536`
  accepts only an existing host-minted session-bound audience or invokes that
  producer using admitted session entry, id, key and `senderIsOwner`. Fresh
  resolution requires the native memory provider and session admission (4523).
  The attempt passes the result at 4861-4870 and 4916. Runtime options reach
  tool construction via `/app/dist/agent-tools-DD0_71KJ.mjs:760` (`...options`).
- **Telegram owner/direct:** `/app/dist/bot-message-HYWIRx8p.mjs:934` chooses
  group/direct and line 1005 passes it to inbound context;
  `/app/dist/context-B_k_S6nC.mjs:181` sets ChatType, line 188 sets SenderId.
  `/app/dist/session-accessor.sqlite-entry-Drh07hIN.mjs:86` persists ChatType.
  `/app/dist/command-auth-DPD2ejxk.mjs:437-445` matches sender candidates against
  explicit owners, computing `senderIsOwner` (not mere command authorization).
  `/app/dist/get-reply-DFYHTxys.mjs:3559` carries it into the reply run;
  `/app/dist/agent-runner-run-params-BJ1Xjo0R.mjs:174` forwards it. The shared
  audience producer therefore mints owner-private for owner direct, conversation
  for a Telegram group (even if its sender is owner).
- **WebChat owner/direct:** `/app/dist/chat-send-handler-Duf_7dlJ.mjs:2457`
  spreads `resolveChatSendCallerContext`;
  `/app/dist/gateway-client-identity-CZ8o5hJk.mjs:80-90` sets internal provider,
  direct ChatType and authenticated GatewayClientScopes. ChatType persists via
  the same session accessor. `/app/dist/command-auth-DPD2ejxk.mjs:442-445`
  recognizes internal operator.admin scope as owner; the same reply/run/audience
  path above supplies the tool owner/private fields. Browser profile carrier
  at `/app/dist/chat-send-handler-Duf_7dlJ.mjs:2461` is not write authority.
  **Sender blocker:** `/app/dist/gateway-client-identity-CZ8o5hJk.mjs:85-89`
  omits `SenderId` for operator UI clients, including Control UI/browser-copilot
  (`/app/dist/message-channel-fJ_KMM5a.mjs:20-22`). Runtime sender derives from
  `sessionCtx.SenderId` (`/app/dist/get-reply-DFYHTxys.mjs:3554`) and projects as
  `requesterSenderId` (`/app/dist/agent-tools-DD0_71KJ.mjs:768`). The optional
  profile carrier does not fill that field. Ordinary dashboard writes therefore
  fail the required sender binding even with owner/private audience authority.
- **Host-generated keys:** `/app/dist/session-key-CSDERtm3.mjs:503` generates
  `agent:<id>:<channel>:direct:<peer>`; lines 506-510 choose the main key.
  `/app/dist/session-create-key-BJp-9Sd1.mjs:18` creates dashboard UUID keys.
  Per-account/per-peer/incognito/cloud variants are intentionally not accepted.
- **Forwarding:** native fields originate at
  `/app/dist/helpers-DZ2foAlJ.mjs:461` and
  `/app/dist/inbound-context-DnPzLOsP.mjs:35`, but are not publicly projected.
  Any supplied forwarded signal denies; absence is allowed.

**Compatibility result: NO on the inspected current host if only this adapter
is installed and enabled.** Telegram direct root
`agent:main:telegram:direct:<id>` can pass the gate with its real sender id and
a host-minted private audience; dashboard UUID shapes can pass only with an actual
sender id. The current Control UI ingress omits that id, so dashboard writes deny
without inventing identity or weakening draft binding. Separately, the inspected
configuration disables `memory-core` and has no explicit memory slot override;
this hook/tool adapter registers no `providerRuntime`. Fresh ordinary runs
therefore fail the native-provider prerequisite at embedded-agent line 4523 and
have no host-minted audience. This blocks ordinary Telegram writes too. A valid
already host-minted delegated audience is a distinct path, not ordinary channel
acceptance. Host identity delivery and audience production need separate changes;
none are performed here.

Mocked proposal/confirm tests cover projected Telegram direct and sender-bearing
dashboard contexts, realistic sender-less Control UI denial, group/nonowner/foreign/
subagent/cron/inter-session/non-private/expired denials. Static bundle inspection
and mocked HTTP are **not live runtime acceptance**. No config changes,
installation, restart or live /facts calls were performed.

### Weaker consent contract and residual risk

The agent, not an inbound hook, interprets “yes”. It must display the question and
wait for affirmative owner input in a later turn. The adapter cannot prove delivery,
new-turn timing or semantic consent, and cannot detect forwarded messages with the
current projected fields. Root automation reusing a private root key without any projected run signal cannot
be distinguished from a user turn. An agent can wrongly call confirm immediately or mistake
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
merges/releases/installs and performs candidate-host and private WebChat/Telegram acceptance with the documented projected-context contract.
