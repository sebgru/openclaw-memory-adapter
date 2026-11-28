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

Both channels use the same host-projected write gates: always
`senderIsOwner === true`, nonempty session incarnation, and only host-generated
root `agent:<id>:main`, `agent:<id>:dashboard:<uuid>` or
`agent:<id>:<channel>:direct:<peer>` keys. Reserved automation/inter-session channel
names and all other shapes deny. If `memoryAudience` is present, it must be
owner-private and its required `assertMemoryAudienceCurrent()` must pass before
each backend call and across awaits. Conversation/unknown/invalid audiences deny,
never fall back. **Only an absent audience** permits the private root-key fallback:
the session key is host-generated and the owner flag is host-computed, not model
arguments. These are the trust basis for private owner-chat writes on hosts that
do not mint memory audiences (native provider disabled or CLI/MCP runtime).

Draft binding is session key + incarnation + sender when present, else profile
when present, else session alone. Missing SenderId does not deny. Identity tier
changes cannot downgrade a pending draft's binding. A profile is not an additional
owner-authorization requirement. Optional trigger/run-kind/input-provenance/chat-type,
one-shot and flush signals deny when contrary; missing fields do not block writes.
Any projected forwarded signal denies. Recall uses the same guard, including its absent-audience fallback.

Installed local OpenClaw 2026.11.4 source evidence (not upstream guarantees):

- **Projection:** `/app/dist/openclaw-tools-BcYM16A_.mjs:549-582` carries
  session key/id (559-560), message channel (569), sender id (573), optional local
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
  use profile binding when available, otherwise session + incarnation binding.
  The missing sender no longer blocks writes.
- **Host-generated keys:** `/app/dist/session-key-CSDERtm3.mjs:503` generates
  `agent:<id>:<channel>:direct:<peer>`; lines 506-510 choose the main key.
  `/app/dist/session-create-key-BJp-9Sd1.mjs:18` creates dashboard UUID keys.
  Per-account/per-peer/incognito/cloud variants are intentionally not accepted.
- **Forwarding:** native fields originate at
  `/app/dist/helpers-DZ2foAlJ.mjs:461` and
  `/app/dist/inbound-context-DnPzLOsP.mjs:35`, but are not publicly projected.
  Any supplied forwarded signal denies; absence is allowed.

### Claude CLI/MCP owner delivery (same inspected bundle)

- Reply dispatch spreads `buildReplyRunStateParams` into CLI run parameters at
  `/app/dist/agent-runner-run-CQDcBS33.mjs:2313`; that builder forwards
  `senderIsOwner` at `/app/dist/agent-runner-run-params-BJ1Xjo0R.mjs:174`.
  The sender is forwarded separately at agent-runner-run line 2399.
- Claude registers `bundleMcp: true`, mode `claude-config-file`, at
  `/app/dist/cli-backend-BAKJ1l_y.mjs:106-107`. The local CLI preparation path
  enables bundle MCP at `/app/dist/prepare.runtime-umyUIcT8.mjs:1373-1374`, builds
  the grant context from run parameters at 1396-1407, and resolves tools using
  that context at 1433-1451.
- `/app/dist/mcp-grant-context-C2cIAZ_0.mjs:125-126` carries sessionId/runId;
  line 156 sets `senderIsOwner: params.run.senderIsOwner === true`.
  Lines 75-82 carry a real sender into channelContext when available, without
  inventing one for dashboards. The finalized grant retains context at 19-22.
- MCP authentication uses the bound client grant's owner flag at
  `/app/dist/mcp-http-_ouwzu3w.mjs:111-114`, not an owner claim supplied by the
  model. Its tool cache resolves this context at 418-434.
  `/app/dist/mcp-http.runtime-orG6gnBl.mjs:174` calls shared gateway tool resolution;
  `/app/dist/tool-resolution-DwA7pKWg.mjs:224-226` passes session incarnation and
  owner into common tool options, 246 passes the session key, 280-281 passes
  sender/optional profile, and 302 constructs OpenClaw/plugin tools. Final plugin
  context projects owner at `/app/dist/openclaw-tools-BcYM16A_.mjs:575`.
  No memory audience is added by this MCP route; the absent-audience fallback is
  therefore needed. Neither missing audience nor missing dashboard sender is a
  remaining write blocker.

**Compatibility result: YES, Telegram owner direct; YES, authenticated
operator.admin WebChat/dashboard private root sessions**, after adapter install +
enable with its documented prepared write credential and reachable backend.
The host-computed owner flag reaches the plugin in embedded and local claude-cli
MCP paths. The native-memory-provider prerequisite remains true for audience
minting but no longer blocks writes; missing Control UI SenderId uses the binding
hierarchy above. Non-owner flags (including non-admin browser clients) still deny.
No runtime config change is needed to address these two host gaps. Explicitly
disabled tools, unconfigured credentials, or unsupported session key variants
remain outside this success claim. Unified-tool fact recall now uses the same guard (see below).

Mocked proposal/confirm tests cover Telegram direct without audience, dashboard
without SenderId or audience, session-only/profile-bound drafts, hierarchical
binding changes, group/channel/nonowner/foreign/subagent/cron/inter-session/
non-private/expired denials, and valid private-audience/currentness behavior.
Static bundle inspection and mocked HTTP are **not live runtime acceptance**.
No config changes, installation, restart or live /facts calls were performed.

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

Draft ids bind to session/incarnation and sender, else profile, else session alone
for at most five minutes;
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


### Recall fix-up: host context evidence

Recall now shares the write guard without relaxed secondary authorization:
owner flag true, supported root key, strict present-audience currentness, or
the absent-audience fallback. All subagents are denied, even with inherited
private audience authority; this is stricter than merely requiring an audience.
Conversation audiences never fall back, and backend failure remains unavailable.
Restricted state redaction is unchanged.

`before_prompt_build` **does not receive senderIsOwner on this host**:

- Embedded hook context: `/app/dist/transcript-policy-BLruX4BJ.mjs:15-31`
  constructs key/id (22-23), optional audience/currentness (24-25), trigger (28)
  and channel/identity fields (29-30), but no owner flag.
- `/app/dist/hook-agent-context-C9bjjC7S.mjs:52-88` only builds channel,
  sender/chat and channelContext fields; neither helper supplies owner authority.
- `/app/dist/attempt-system-prompt-prepare-m7PLHYnt.mjs:3932-3938` builds
  the prompt hook context from that embedded constructor and adds model/provenance
  fields, not owner. `/app/dist/context-engine-maintenance-eb6VdEkC.mjs:326-329`
  passes it unchanged to `runBeforePromptBuild`.
- Harness hook context: `/app/dist/hook-context-CrfJ-FCU.mjs:5-38` exposes
  key/id (13-14), optional audience/currentness (15-18), trigger/provenance
  (26-27), and identity fields, again no owner flag.
  `/app/dist/agent-harness-runtime-DfOyfkfo.mjs:322` constructs it; line 344
  passes it to `runBeforePromptBuild`.

Do not infer owner from senderId, prompt text, config, or remembered tool context.
Automatic prompt-hook fact recall therefore remains unavailable here, safely.
The working source is the unified-search **tool factory context**: the embedded
and Claude MCP owner projection cited above reaches
`/app/dist/openclaw-tools-BcYM16A_.mjs:575`; session key/id are at 559-560.

After adapter install + enable (prepared credential, reachable backend, tools enabled):

| Channel | Save | Unified-tool fact recall | Prompt-hook fact recall |
| --- | --- | --- | --- |
| Owner Telegram private root direct | YES | YES | NO (owner flag omitted) |
| Authenticated operator.admin dashboard private root | YES | YES | NO (owner flag omitted) |
| Non-owner / group / channel / subagent / cron / hook / heartbeat / inter-session | NO | NO | NO |

These are source-backed compatibility verdicts, not live acceptance. Both recall
entry points have synthetic owner/root fallback, denial and failure regressions.
No host changes, install, restart or live facts requests were made.

## Native memory routing (1.14.0, default off)

`nativeRouting` imports `openclaw/plugin-sdk/memory-host-search` at call time
and uses only `getActiveMemoryProvider` (provider-neutral lease: `search`,
`close`, `capabilities.sources`). OpenClaw 2026.11.4 exports this subpath in
its package and resolves it for external plugins, but the SDK docs label it a
private-local bundled facade. Treat it as an unstable dependency:

- Re-test after every OpenClaw upgrade (import succeeds, lease opens with
  session authority, `search` returns `hits` with `excerpt`/`score`/`reference`).
- If the import or lease fails, the native lane fails closed: the prompt hook
  falls back to the service `scope=main` search and both paths add a
  "native memory unavailable" notice.
- The documented public alternative is Gateway `memory.search` with
  `version: 2` over an authenticated operator connection. In-process
  `api.runtime.gateway.request` is limited to bundled or trusted-official
  plugins on 2026.11.4, so it is not available to this adapter.

Smoke-tested 2026-11-28 against OpenClaw 2026.11.4 in an isolated state
directory (standalone process, legacy memory-core adapter path), not inside a
running Gateway.
