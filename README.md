# OpenClaw Memory Adapter

[![CI](https://github.com/sebgru/openclaw-memory-adapter/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sebgru/openclaw-memory-adapter/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/sebgru/openclaw-memory-adapter/branch/main/graph/badge.svg)](https://codecov.io/gh/sebgru/openclaw-memory-adapter)
[![License: MIT](https://img.shields.io/github/license/sebgru/openclaw-memory-adapter.svg?branch=main)](LICENSE)

An external OpenClaw plugin that retrieves bounded memory context from an HTTP
memory service. It is deliberately separate from OpenClaw's bundled memory
indexer and never invokes indexing.

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
- The prompt hook uses `scope=all` with `profile=prompt`; the explicit tool
  uses `profile=tool` and supports scopes `all`, `main`, `archive`, and
  `documents`. It never calls `/index`.

## Unified memory search tool

The plugin registers an explicit `unified_memory_search` tool that agents can
invoke directly:

- `query` (required): question or search terms.
- `scope` (optional): `all` (default), `main`, `archive`, or `documents`.
  Searching the session archive or indexed documents is always explicit.
- `maxResults` (optional): 1–10, overrides the configured `maxResults`.

Results include source metadata (path, heading, line), relevance/lexical/
semantic scores, provenance, and alternate provenance when the service
provides them. Per-result text is bounded to `maxResultTextLength` and total
injected context is bounded to `maxContextLength`. Service warnings are
surfaced alongside results. The tool response's `details.receipt` carries the
schema-v2 status/source-coverage receipt for that explicit search; it contains
no query or result text.

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
- **absent** — the search completed successfully with zero results. This no
  longer returns silently: the model receives an explicit notice that
  retrieval was attempted and found nothing, so it does not have to guess
  whether memory was searched.
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
