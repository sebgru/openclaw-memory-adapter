# OpenClaw Memory Adapter

[![CI](https://github.com/sebgru/openclaw-memory-adapter/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sebgru/openclaw-memory-adapter/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/sebgru/openclaw-memory-adapter/branch/main/graph/badge.svg)](https://codecov.io/gh/sebgru/openclaw-memory-adapter)
[![License: MIT](https://img.shields.io/github/license/sebgru/openclaw-memory-adapter.svg?branch=main)](LICENSE)

An external OpenClaw plugin that retrieves bounded memory context from an HTTP
memory service. It is deliberately separate from OpenClaw's bundled memory
indexer and never invokes indexing.

What this plugin is for, and what every change must preserve, is defined in
[Requirements](REQUIREMENTS.md).

## Behavior

- Calls `GET {endpoint}/unified/search?q=...&scope=all&limit=5&profile=prompt`.
- Exposes the `unified_memory_search` tool for explicit searches across main
  memory, registered artifacts, indexed documents, and the optional session
  archive.
- Adds normalized results to `before_prompt_build` as reference context.
- Uses retrieval profiles: `prompt` (automatic hook, strict relevance) and
  `tool` (explicit tool calls, caller-controlled scope).
- Surfaces service warnings in tool output and logs; returns a bounded
  failure notice when the service is unavailable.
- Uses a short timeout and fails closed when the service is unavailable.
- Supports agent/chat allowlists.
- Skips automatic recall on non-human turns: heartbeat, cron and memory-flush
  triggers (`ctx.trigger`) and inter-session or internal-system input
  (`ctx.inputProvenance.kind`). The explicit `unified_memory_search` tool stays
  available on those turns. A turn with no trigger or provenance information
  is treated as a normal turn.
- Detects topics (family, home, vehicle, finance, insurance, school or
  childcare, work, health) in the prompt with a deterministic German/English/
  Russian lexicon plus configured entity aliases. A triggered turn adds one
  `scope=documents` lookup that runs in parallel with the baseline search and
  reserves document slots in the injected context. See
  [Topic-triggered document search](#topic-triggered-document-search).
- The prompt hook uses `scope=all` with `profile=prompt`; the explicit tool
  uses `profile=tool` and supports scopes `all`, `main`, `archive`, and
  `documents`. It never calls `/index`.
- When a prompt contains one high-confidence explicit entity or identifier
  (for example, a quoted name, email, filename/path, repository, or
  multi-token proper name) and the baseline results do not contain it, the
  hook makes at most one exact-target follow-up search. Filename/path targets
  use `scope=documents`; other targets use `scope=all`. It does not guess
  aliases: an explicitly linked `aka`/`alias`/`also known as` pair in the
  current prompt is included in the same query. A missing result is not proof
  of absence. The baseline and
  follow-up share a 6-second retrieval budget; a failed follow-up is disclosed
  and prevents a verified-absence claim.

## Unified memory search tool

The plugin registers an explicit `unified_memory_search` tool that agents can
invoke directly:

- `query` (required): question or search terms.
- `scope` (optional): `all` (default), `main`, `archive`, or `documents`.
  Searching the session archive or indexed documents is always explicit.
- `maxResults` (optional): 1–10, overrides the configured `maxResults`.

Results include source metadata (path, heading, line), relevance/lexical/
semantic scores, provenance, and alternate provenance when the service
provides them. Structured provenance is preserved as bounded source/path/
heading/line fields (legacy string provenance remains supported); up to three
alternate citations are retained and shown in injected context. Per-result
text is bounded to `maxResultTextLength` and total
injected context is bounded to `maxContextLength`. Service warnings are
surfaced alongside results. The tool response's `details.receipt` carries the
schema-v2 status/source-coverage receipt for that explicit search; it contains
no query or result text.

### Low-confidence results

When `/unified/search` returns `low_confidence: true` (no lexical match and only
weak semantic similarity), the adapter keeps the results but adds a fixed,
adapter-owned caution after them: in the prompt context (both legacy and
receipt mode) and in the `unified_memory_search` tool text. The tool's
`details.lowConfidence` and the receipt's additive `lowConfidence` boolean
(also in the trace summary) mirror it. Only a literal boolean `true` counts, and
the service's free-text `confidence_note` is deliberately dropped, never shown
to the model. The flag never changes receipt `status`: a flagged result set stays
`found`, and it is neither a verified absence nor a retrieval failure. It is
ignored for zero-result and error receipts. After an entity follow-up merge the
flag is kept only if both responses carried it.

`deduplicateResults` is an optional, default-off provenance deduplication flag
for both automatic and explicit searches. When enabled, repeated results with
the same stable ID, or the same source/path/line tuple, collapse to the first
(highest-ranked) result in the returned page. Unlocated chunks remain distinct
to avoid merging unrelated text. This does not issue another search or fill
vacated slots; receipt counts reflect the returned deduplicated results.

## Configuration

The plugin is configured through OpenClaw's normal plugin configuration:

```json
{
  "plugins": {
    "entries": {
      "memory-adapter": {
        "enabled": true,
        "config": {
          "endpoint": "http://memory-service:8080",
          "timeoutMs": 1500,
          "maxResults": 5,
          "scope": "all",
          "maxQueryLength": 4000,
          "maxContextLength": 12000,
          "maxResultTextLength": 2000,
          "turnReceipts": false,
          "deduplicateResults": false
        }
      }
    }
  }
}
```

## Native memory routing (`nativeRouting`, default off)

With `nativeRouting.enabled: true` the adapter stays the single search entry
point but splits the work by tier:

| Tier | Served by |
|---|---|
| curated memory, notes (`memory/`, `MEMORY.md`), optionally session transcripts | native OpenClaw memory (`memory-core`) |
| documents, session archive, registered outputs/projects | external memory service |

When the flag is absent or `false`, nothing below applies and every search
goes to the external service exactly as before.

```json
"nativeRouting": {
  "enabled": true,
  "sources": ["memory"],
  "lowConfidenceScore": 0.35,
  "timeoutMs": 2500,
  "promptServiceScope": "none"
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Turns routing on. |
| `sources` | `["memory"]` | Native corpora to search: `memory` and/or `sessions`. |
| `lowConfidenceScore` | `0.35` | Native results whose best score is below this are disclosed as low confidence. `0` disables the check. |
| `timeoutMs` | `2500` | Native lane budget (250–6000 ms), also capped by `timeoutMs`. |
| `promptServiceScope` | `"none"` | Extra service lane for every prompt-hook turn: `none`, `main` or `all`. |

**`unified_memory_search`.** `scope: "all"` and `scope: "main"` run the
native lane and the service lane (same scope) in parallel. Results alternate
between lanes, native first, because scores from the two engines are not
comparable. Service copies of native-owned paths (`memory/`, `MEMORY.md`,
`sessions/`) are dropped, except for identifier-like queries (snake_case or
dotted IDs, ticket codes, `#123`, versions, commit hashes, e-mail addresses,
file names, mixed letter/digit tokens, or at most three words), where the
lexical service lane may hold the only exact hit. `scope: "documents"` and
`scope: "archive"` stay on the service only.

**Prompt hook.** Native memory is the baseline. The service is not searched
with `scope=all` on every turn (all-scope on long prompts was measured at
several seconds). It is searched only when:

- the topic/entity trigger starts its `scope=documents` lane (unchanged);
- the prompt is identifier-like (`scope=main`, same timeout);
- an explicitly named entity found no evidence (targeted lookup, unchanged);
- `promptServiceScope` is `main` or `all`;
- native memory failed: a `scope=main` fallback runs within the remaining budget.

**Native access.** The adapter calls the host's provider-neutral memory lease
(`getActiveMemoryProvider` from `openclaw/plugin-sdk/memory-host-search`)
with the current turn's session key, session ID, sandbox state and the
host-minted memory audience from the hook/tool context. It never builds
authority itself; without a session key the native lane fails closed. The
selected memory plugin applies its own visibility rules to session hits.
This SDK subpath is exported by OpenClaw 2026.11.4 but documented as a
private-local facade, so it can change without notice; see COMPATIBILITY.md.

**Disclosure (R8).** Native memory emits no low-confidence signal. The adapter
flags a native result set when its best score is below `lowConfidenceScore`.
The merged answer is flagged only when every lane that contributed is weak,
and a fixed notice is added in both legacy and receipt mode. The default 0.35
comes from a 20-case comparison (no-match top-1 0.22/0.32 vs lowest relevant
top-1 0.35); it is not validated on a larger no-match set and should be
tuned before relying on it. When the native lane fails, a fixed "native
memory unavailable" notice is added and receipts never report a verified
absence for that turn.

Routing does not enable `memory-core` or hide its own `memory_search` tool.
Both are Gateway configuration decisions.

## Topic-triggered document search

Personal reference facts (address, children, school, bank, insurance, car,
employer, health) live in the documents scope, where a broad `scope=all` search
can rank them below sessions and notes. On an eligible human turn the adapter
therefore checks the prompt against a topic lexicon, without any model call.
When a topic matches:

1. The baseline `scope=all` search starts as before.
2. At the same time a second search with `scope=documents` and
   `profile=prompt` starts, using the same query. The two run in parallel, so a
   triggered turn takes as long as the slower of the two, never the sum.
3. The results are merged: the relative order of retained baseline results is
   preserved, results already present or repeated within the documents lane
   are counted once, and up to `documentSlots` distinct documents (default 2;
   baseline documents count first and are never evicted) are guaranteed in the
   final `maxResults`. To make room, the lowest-ranked non-document baseline
   entries may be replaced. The guarantee is bounded by `maxResults` and by
   the number of distinct documents available. Free slots up to `maxResults`
   are filled with further documents.

Turns that do not match keep the existing single `scope=all` search. Internal
turns (heartbeat, cron, memory flush, inter-session) and chats outside the
configured allowlists never run either search.

**Budget.** The documents lookup uses the adapter `timeoutMs` (or the lower
`topicTrigger.timeoutMs`), capped at six seconds. It adds no wall-clock time
beyond the baseline timeout and shares the existing six-second turn budget with
the optional exact-entity follow-up, so a turn issues at most three requests:
baseline, documents, and one entity follow-up. The adapter timeout is not
raised.

**Failure is soft and disclosed.** If the documents lookup fails or times out,
the baseline context is still injected, with a fixed notice that the focused
document search was unavailable and that absence must not be claimed. In
receipt mode the receipt reports unverified coverage, so a zero-result turn is
`unverified`, never a verified absence. A failure of the baseline search is
handled as before (unavailable notice).

**Category hint.** The backend's `/unified/search` has no category or document
type parameter, so none is sent. The matched categories are used only to
decide that the documents lookup is warranted.

**Privacy.** Detection returns category names only. The debug log records a
count and the outcome (`merged` or `unavailable`), never the prompt, the matched
text, category names, or alias names.

### Lexicon and matching

The default lexicon (`src/topic-lexicon.js`) is generic: no personal names.
It covers synonyms and inflected forms in German, English and Russian, for
example school/`Schule`/`Grundschule`/`Kita`/`школа`/`детский сад`. Ambiguous
everyday words ("work", "home", "job", "address", "analysis", "health check")
are deliberately absent so ordinary technical turns do not trigger.

Matching is lexical, so generic English words still cause false positives:
"river bank" or "bank holiday" (finance), "Refactor the car class" (vehicle),
"The mother board is dead" or "kids API endpoint rename" (family), and
"Update the Chef cookbook" (work) all trigger. A false positive costs one extra
parallel documents request and, if that request fails, the fixed
"focused document search unavailable" notice. If a term is too noisy for your
use, switch the whole category off with `disabledCategories`; the default
lexicon itself cannot be edited through configuration.

Matching is case-, diacritic- and umlaut-digraph-insensitive (`Kündigung`,
`Kuendigung` and `kundigung` are equal; `Ё` equals `Е`) and whole-word. Term
syntax, for `extraTerms` and `entityAliases`:

| Term | Matches |
|---|---|
| `bank` | the word `bank` only |
| `kind*` | words starting with `kind` (`kinder`, `kindern`) |
| `*schule` | words ending in `schule` (`grundschule`) |
| `*versicherung*` | words containing it (`autoversicherung`, `versicherungen`) |
| `report card` | the phrase; any whitespace run matches |

Terms are 2 to 64 characters, at most 200 per list and category.

### Configuration

```json
{
  "topicTrigger": {
    "enabled": true,
    "documentSlots": 2,
    "timeoutMs": 1500,
    "disabledCategories": ["vehicle"],
    "extraTerms": {
      "home": ["gartenhaus", "carport*"],
      "pets": ["hamster*", "tierarzt*"]
    },
    "entityAliases": {
      "family": ["Zed Example", "Zoë"],
      "school": ["Example Grundschule", "Beispiel-Kita"],
      "work": ["Example Corp"],
      "vehicle": ["Samplemobil"]
    }
  }
}
```

(Names above are invented examples.)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Set `false` to disable topic detection and the documents lookup. |
| `documentSlots` | `2` | Document results guaranteed in the merged result (1 to 10). |
| `timeoutMs` | adapter `timeoutMs` | Optional timeout cap for the documents lookup (250 to 6000 ms); never above the adapter timeout. |
| `disabledCategories` | `[]` | Default categories to switch off: `family`, `home`, `vehicle`, `finance`, `insurance`, `school`, `work`, `health`. |
| `extraTerms` | `{}` | Extra terms per category; an unknown category name (lowercase letters, digits, `_`, `-`) creates a custom category. |
| `entityAliases` | `{}` | Names and organisations per category (family members, school, employer). A name also matches its possessive (`Zoë's`, `Zoës`); use a wildcard such as `Зорвек*` for inflected names. |

Entity aliases belong in plugin configuration only. Do not commit real names to
this repository. A bare first name alias matches every whole-word occurrence of
that name, so prefer full names when a first name is also a common word.

## Per-turn receipts (`turnReceipts`, default off)

`turnReceipts` is a named, default-off flag. With it unset or `false`, the
`before_prompt_build` hook keeps its original behavior exactly: zero results
prepend nothing, and a hard failure prepends the fixed unavailable notice.

When `turnReceipts: true`, every eligible turn produces a versioned, ephemeral
receipt (`src/receipt.js`, `schemaVersion: 2`) that classifies the single
`scope=all` retrieval call as one of:

- **found** — results were returned. The existing formatted context is
  prepended, but "found" is no longer silent-by-default: if source coverage
  is unverified (see below) or nothing retrieved was actually attached to
  the turn, a notice is appended alongside the context instead of being
  suppressed.
- **absent** — the search completed successfully with zero results *and*
  every requested source has confirmed searched coverage. This no longer
  returns silently: the model receives an explicit verified-absence notice.
- **unverified** — zero results, but at least one requested source is
  unknown or not searched (warnings, strict mode without coverage, a partial,
  empty, or invalid `coverage` map, or a requested `not_searched` source).
  This is never worded as a verified absence.
- **unavailable** — the call threw or timed out. This is never reported as
  absence; the model receives the unavailable notice and is told not to
  assert memory-backed facts.
- **conflicting** — only reachable if the memory service itself returns a
  `conflicts` array in its JSON response. The adapter does not infer
  conflicts from result text; it only passes through what the service
  reports.
- **not searched** — sources outside the requested scope. The automatic hook
  always requests `scope=all`, so this is only populated for the explicit
  `unified_memory_search` tool when a caller narrows `scope`.

### Partial/unknown source coverage

The memory service's normalized response carries only a flat `warnings:
string[]` array — it never reports which individual source (main, archive,
documents) a warning applies to (see `normalizeResults` in `src/client.js`).
So whenever the service returns one or more warnings for a `scope=all` (or
narrower) call, the receipt cannot claim that every requested source was
fully searched. In that case `sources.searched` stays empty and the affected
sources move into `sources.unknownCoverage` instead — regardless of whether
the receipt's status is `found`, `absent`, or `conflicting`. The model-facing
notice names this as unverified coverage and reports the warning count. The
notice itself omits warning text; sanitized warning
details remain available in the explicit tool response, capped at 256
characters per entry. Warning details are never copied into logs.

### Service-reported coverage and `requireServiceCoverage`

A source is only classified as searched/absent on positive evidence. If the
service response includes `coverage: { main|archive|documents:
"searched"|"unavailable"|"not_searched" }`, that map is authoritative per
source: `searched` sources can be absent, `unavailable` sources land in
`sources.unavailable`, `not_searched` in `sources.notSearched`, and any
requested source the map omits (or gives an invalid value) stays in
`unknownCoverage`. Zero results with any unavailable source yields status
`unavailable`, with `sources.absent` limited to the sources that were actually
searched. A thrown/timed-out call always marks every requested source
unavailable, regardless of any coverage claim.

Present-but-invalid `coverage` (empty map, no valid entries, non-object) still
counts as reported: every source is unknown and the status is never `absent`.
Current services do not report `coverage`, so when the field is genuinely
absent a clean response (no warnings) is still treated as full coverage, as
before; absent coverage *with* warnings is `unverified`. Set
`requireServiceCoverage: true` (default `false`) to disable that inference:
without an explicit `coverage` map, no source is reported searched or absent
and the notice says coverage is unverified. Receipts remain ephemeral; nothing
is stored.

### Zero included content

A result can be returned by the service (`resultCount > 0`) yet still produce
no usable context, e.g. every candidate line exceeds `maxContextLength` and
gets dropped before anything is included. The receipt tracks this separately
as `includedCount` / `noContentIncluded`; when it happens, the adapter does
not prepend the (effectively empty) formatted header and instead tells the
model explicitly that no usable memory context was attached this turn.

The receipt carries a turn ID (the harness's `currentUserMessageId` or
`runId` when available, otherwise a generated UUID), status, bounded source
lists (including `unknownCoverage`), up to five sanitized warnings and
conflicts capped at 256 characters each, and a turn ID capped at 128
characters. It contains no raw query or result text, plus `includedCount`, a
truncation flag, and start/end timestamps. It is built in memory for the
current hook invocation only and is never persisted to a database.

### Execution trace

`before_prompt_build` can only return `prependContext` (and a few sibling
fields) — there is no supported field for returning structured metadata from
that hook. So when `turnReceipts: true`, the adapter also emits one bounded,
JSON-formatted trace line per turn through the plugin's scoped logger
(`api.logger.debug`): `turnId`, `schemaVersion`, `status`, `resultCount`,
`includedCount`, `truncated`, `partialCoverage`, bounded `sources`, and
`timing`. It deliberately excludes warnings/conflicts text and all result
content. This is the supported, documented mechanism available for making
the receipt observable to runtime acceptance checks or diagnostics without a
parallel receipt database; with `turnReceipts` off (the default), no such
line is logged and behavior is unchanged.

This is not an automatic hook-to-hook accessor: `before_prompt_build` still
does not return structured metadata. However, every explicit
`unified_memory_search` tool response now includes the ephemeral schema-v2
receipt at `details.receipt`, alongside the existing `scope`, `results`,
`warnings`, and `conflicts`. This is the versioned receipt contract for a caller
that explicitly invokes the tool before dispatch; it contains status, bounded
source coverage, timing, counts, and truncation flags, but no query or result
text. The orchestration adapter still needs a supported runtime mechanism for
invoking the tool and forwarding its receipt to workers; automatic receipt
access remains out of scope. See the architecture proposal, §5A and open
decision 2.

The endpoint is runtime configuration; no deployment-specific hostname is
required by this repository.

## External installation and upgrades

Install a tagged release with OpenClaw's plugin installer:

```sh
openclaw plugins install github:sebgru/openclaw-memory-adapter#v0.1.0
```

Alternatively, install a checked-out release directory with
`openclaw plugins install /path/to/openclaw-memory-adapter`. Enable the plugin
and set its endpoint through OpenClaw's normal configuration. Keep the plugin
outside the OpenClaw image and pin its version independently. Do not patch
`node_modules` or bundled OpenClaw files.

For an OpenClaw upgrade:

1. Keep the adapter release pinned.
2. Test the new OpenClaw version with the existing adapter.
3. Upgrade the adapter only when its compatibility entry requires it.
4. Restart the Gateway once after changing either component.
5. Retain the previous image and adapter release for rollback.

The repository should maintain a compatibility matrix as OpenClaw releases
are tested.

The plugin uses the documented hook-based compatibility baseline. See
`COMPATIBILITY.md` for the currently tested status; an untested OpenClaw
release should be treated as a staging candidate, not upgraded directly in
production.

## CI

- **CI** (`ci.yml`): ESLint, syntax check, tests with coverage (100% enforced by `c8 --100`), and a Codecov upload.
- **Release** (`release.yml`): triggered only on version tags (`v*.*.*`); runs lint and tests, verifies the tag matches `package.json`, builds the npm package tarball, and attaches it to a GitHub Release.

The CI job uploads `coverage/lcov.info` to Codecov using the `CODECOV_TOKEN`
repository secret, and the build fails if the upload fails. Coverage gating is
declared in `codecov.yml`: both the project and patch statuses target 100%,
matching the local `c8 --100` threshold, so CI and Codecov agree.

To publish a release:

```sh
git tag v0.1.0
git push origin v0.1.0
```

Install the tagged release with OpenClaw from GitHub:

```sh
openclaw plugins install https://github.com/sebgru/openclaw-memory-adapter/releases/download/v1.0.0/sebgru-openclaw-memory-adapter-1.0.0.tgz
```

## Development

```sh
npm install
npm run lint
npm run check
npm test
npm run test:coverage
```

Tests use a local stub for `openclaw/plugin-sdk/plugin-entry` (see
`test/stubs/`) so the plugin entry is importable and fully covered without a
running OpenClaw Gateway. When the real `openclaw` peer package is present, it
is used instead.

## Opt-in owner-private fact drafts (D.3)

**Off by default.** Requires memory backend v1.24.0 (authenticated fact routes)
plus the OpenClaw hook/audience/prepared-secret contracts in COMPATIBILITY.md.
This does not enable automatic profile injection, extraction, curated-file edits,
or a second fact-search tool.

Merge this fragment into the existing adapter entry (retain your existing
endpoint, scopes, chat allowlists and other settings):

```json
{
  "plugins": {
    "entries": {
      "memory-adapter": {
        "enabled": true,
        "config": {
          "endpoint": "http://memory-sebg:8080",
          "facts": {
            "enabled": true,
            "bearerToken": {
              "source": "exec",
              "provider": "secretref",
              "id": "MEMORY_FACTS_WRITE_TOKEN"
            }
          }
        }
      }
    }
  }
}
```

The existing `secretref` provider must resolve the **same instance token** used by
`memory-sebg`, not a new token. The manifest declares `facts.bearerToken` as a
capability-owned SecretRef input. The SDK's `getPreparedPluginSecretInput` supplies
only the startup-prepared secret in current plugin scope. Missing/unavailable
secret fails closed; no environment fallback, plaintext config, cold resolver or
credential logging is used. Requests reject redirects and credential-bearing URLs.

### Option C: explicit agent tools

1. The agent calls `memory_fact_propose` when the owner says “remember this”,
   or suggests a reference fact itself. It supplies the registry-linked subject,
   predicate, exact value/type/unit/privacy and effective date (unknown stays null).
   The backend creates `/facts/drafts`, never a saved fact. The returned short
   question includes the draft id, value and lifecycle targets. Show it to the owner.
2. **Wait for the owner's affirmative response in a later turn**, then call
   `memory_fact_confirm` with that exact draft id. Do not confirm your own suggestion,
   quoted/forwarded text, silence or ambiguous replies. No/edit means no confirmation;
   an edit requires a new proposal. The adapter binds the id to host session,
   incarnation and sender (requester profile is optional metadata), with a TTL of at most **five minutes**
   (or the backend's earlier expiry). Foreign, replayed or expired drafts are denied.
   Consumption happens before network I/O: an uncertain result must not be retried;
   check backend state and propose anew.
3. End, replace, retract and forget use the same proposal/confirmation pattern.
   Forget maps to backend retract. Successful retraction clears pending drafts and
   in-flight authority. Session lifecycle/reset invalidates drafts; restart loses
   volatile state. Curated-file mirrors require separate reviewed diffs. Forget
   purges the store value, not prior chats/tool histories, external caches or backups.

**Authorization and channel scope:** both tools always require the host-computed
`senderIsOwner === true`, a nonempty session incarnation (`sessionId`), and a
host-generated root key matching `agent:<id>:main`,
`agent:<id>:dashboard:<uuid>` or `agent:<id>:<channel>:direct:<peer>`.
Group/channel/subagent/cron/hook/heartbeat/inter-session and other key shapes deny,
even with inherited private audience authority. Account-qualified and per-peer
direct keys are outside this bounded contract. CLI one-shot and memory-flush runs
deny. Optional chat-type/run-kind/provenance fields, when present, must not
contradict a direct external-user turn; their absence is allowed. Any projected
forwarded signal denies.

When `memoryAudience` is present it must be `owner-private`, with a callable
`assertMemoryAudienceCurrent()` checked before every backend call and after
awaits. A conversation, unknown or invalid audience **never falls back**. When
`memoryAudience` is absent, the host-generated private root key plus the
host-computed owner flag are the private-chat proof. This intentional fallback
supports native-memory-disabled hosts and CLI/MCP runtimes without weakening
non-owner or group denial. Context must come from the host tool factory, never
from tool parameters, config, prompt JSON or session lookups.

Drafts bind to session key + incarnation, then to `requesterSenderId` if present,
else `requesterProfileId` if present, else the session alone. Missing SenderId
does not deny. Changing identity tier, sender, profile (when profile-bound), session
or incarnation requires a new draft; profiles are not an additional owner gate.

**Installed-host compatibility: YES for owner Telegram direct and authenticated
operator.admin WebChat/dashboard private root sessions after install + enable**
(with the documented prepared write credential and backend configured). Static
bundle inspection verifies owner flag delivery to both embedded and claude-cli
MCP plugin tool contexts. Neither disabled native `memory-core` nor omitted
Control UI SenderId blocks writes with this fallback. This is source-backed
compatibility, **not live runtime acceptance**; no install or live writes were
performed. Unified-tool fact recall uses the same owner/root fallback. Prompt-hook
fact recall remains unavailable on this inspected host because its context omits
`senderIsOwner`; use `unified_memory_search` as the trusted working recall path.
See [COMPATIBILITY.md](COMPATIBILITY.md) for exact file:line evidence.

**Residual risk accepted in Option C:** owner account compromise = owner, on
Telegram as on WebChat. There is no additional browser requester-profile trust
requirement. The agent interprets the owner's “yes”; the adapter cannot attest a
fresh confirmation message, a later turn, or successful display of the proposal.
A model could wrongly confirm immediately. Native forwarding metadata is not
currently projected; forwarding is not detectable there. Any projected
`messageProvenance: "forwarded"` or native forwarding metadata denies operations;
missing forwarding metadata alone is allowed. Copy/paste and quotations can also
mislead the agent. This is agent-asserted consent, not a transport-attested reply
protocol; no `inbound_claim`/`message_sent` dependency remains. Root-key screening and any available contrary run signals exclude identifiable
automation, not forwards or semantic consent errors. Automated work reusing a root
key without a projected run signal is indistinguishable from a user turn.

Semantically reject credentials, secrets and transient health/dose state before
proposal. Conservative adapter screening and backend validation are additional
checks, not complete semantic detection. Custom/derived/volatile predicates are
unsupported; weight stays in its canonical food log.

### Automatic current-fact recall

When the flag is on, `unified_memory_search` and eligible `before_prompt_build`
auto-recall render current facts **before evidence**, without needing an explicit
fact tool call when the host supplies owner authority. Read access uses exactly
the write guard: `senderIsOwner === true`, a supported private root, and either
a current owner-private audience or the absent-audience fallback described above.
Present nonprivate/expired audiences never fall back. Subagents remain denied,
even with inherited private authority (a deliberately conservative restriction).
All checks run before requests and after awaits; failures mean unavailable, not
absence. Restricted current-state redaction is unchanged.

**Inspected-host limitation:** both native and harness `before_prompt_build`
contexts omit `senderIsOwner`. Automatic hook facts therefore fail closed. The
host tool factory (including local Claude MCP) does supply the computed owner
flag, so `unified_memory_search` is the safest working recall source for Telegram
owner direct and authenticated dashboard private roots after install + enable.
No sender-id/config inference or cross-turn authority cache is used. See
[COMPATIBILITY.md](COMPATIBILITY.md) for exact bundle citations.

The backend requires a concrete slot, so automatic recall uses a bounded parallel
slice of the 18 registry predicates for `person:owner` (no item key), with no cache
or free-text predicate guessing. It is **not enumeration of all people or keyed
set members**. Use explicit `fact_subject` and `fact_predicate` for another concrete
slot; the existing backend/API still needs an item-key enumeration extension for
complete keyed-family/vehicle/etc. profiles. Automatic slices do not claim that
those other slots are absent. Existing baseline/topic/entity evidence retrieval
remains in auto-recall. With facts enabled, explicit unified searches use the
bounded authenticated fact-aware path; legacy receipts/details remain unchanged
when the feature is off.

Current-state JSON preserves source/date/rank, alternatives/history and
stale/conflict/unreviewed/mail-only/unknown/derived disclosures. T0 means
agent-asserted owner provenance, not curated-file verification. Missing, malformed
or failed fact lanes show **unavailable**, never verified absence. Restricted
records, derived values and source identifiers are recursively withheld; the
legacy `include_restricted` parameter does not authorize disclosure under Option C.
Fact values, query text, credentials and backend exception details are not logged
by the adapter fact path. Unified fact-tool searches carry explicit slot markers
so the compatible backend also suppresses query logging. Ordinary evidence-only
prompt searches retain the backend's general-search logging policy. Agent-visible tool results/chat history necessarily contain the
read-back; do not confuse log redaction with history deletion.

### Privacy-safe fact diagnostics (1.13.0)

Failed fact operations emit a plugin `warn` line with this exact format:

```text
memory-adapter: facts unavailable stage=<stage> reason=<code> hints=<JSON object of presence booleans>
```

Stages are `hook-current`, `tool-recall`, `propose` and `confirm`. An implicit
current-fact slice invoked by tool recall uses `tool-recall`; prompt revalidation
uses `hook-current`. Codes are `DISABLED`, `OWNER_FLAG_MISSING`, `OWNER_FALSE`,
`AUDIENCE_KIND`, `AUDIENCE_STALE`, `TRIGGER_KIND`, `CHAT_TYPE`, `PROVENANCE`,
`ONE_SHOT`, `MEMORY_FLUSH`, `SESSION_SHAPE`, `FORWARDED`, `INVOCATION_STALE`,
`SECRET_UNPREPARED`, `INVALID_ENDPOINT`, `HTTP_<status>` (numeric 100–599),
`TIMEOUT`, `STATE_SHAPE`, `RESPONSE_SHAPE` and `UNKNOWN`. Missing audience
validators and rejected audience-currency assertions both use `AUDIENCE_STALE`.
Unclassified failures, including draft screening/scope/expiry failures, use
`UNKNOWN`; caught error text is never logged.

The JSON object contains only these fixed keys, in this order: `senderIsOwner`,
`memoryAudience`, `assertMemoryAudienceCurrent`, `assertInvocationCurrent`,
`trigger`, `runKind`, `runType`, `chatType`, `inputProvenance`, `oneShotCliRun`,
`memoryFlush`, `sessionId`, `sessionKey`, `messageProvenance`. Each value means
only that the corresponding context field is not `undefined`, **not** its value
or truthiness. Session identifiers are used only in an in-memory dedupe key and
never emitted. No credentials, endpoint/query text, fact payloads, prompts,
sender/profile identifiers or exception details are logged.

Identical session/incarnation + stage + reason lines are suppressed for 60
seconds (at most 256 retained keys per plugin instance). Success is silent.
Logging failures cannot change replies. Authorization, external unavailable
notices, request timeouts and fail-closed behavior are unchanged. These codes
diagnose a newly observed failure; they do not prove a historical root cause.
After merge and installation, this diagnostics-only update needs a **plugin
reload, not a Gateway restart**. This change does not install or activate it.

### Later operator enablement

Review/merge PR #23 after CI and independent approval, release a new minor adapter
version, install that pinned release, merge the SecretRef config above, and use the
separately approved Gateway restart procedure. Verify SDK/SecretRef and the local
chat-type and current-run provenance projection against the candidate host before
activation. In real owner-private WebChat and Telegram direct chats, propose, inspect the question, answer yes, confirm, verify
persistence/recall, then verify forget. Test nonowner/group/synthetic/expired/replayed
and foreign draft denials. Installed-host writes remain blocked until the missing
host fields are genuinely projected; do not fabricate them or bypass checks. No synthetic production facts are seeded
by this task. No config, install, restart, merge or live facts request was performed.
