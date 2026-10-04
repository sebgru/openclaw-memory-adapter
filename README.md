# OpenClaw Memory Adapter

[![CI](https://github.com/sebgru/openclaw-memory-adapter/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sebgru/openclaw-memory-adapter/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/sebgru/openclaw-memory-adapter/branch/main/graph/badge.svg?token=jwMr8sJGGb)](https://codecov.io/gh/sebgru/openclaw-memory-adapter)
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
surfaced alongside results.

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
          "maxResultTextLength": 2000
        }
      }
    }
  }
}
```

The endpoint is runtime configuration; no deployment-specific hostname is
required by this repository.

## Memory layers and Dreaming curation

This section describes how the adapter fits into the reference deployment it
was built for. It is operational context, not plugin behavior: the plugin
itself only retrieves. Workspace paths are relative to the OpenClaw agent
workspace. Times are Europe/Berlin.

### Retrieval path

- OpenClaw's bundled `memory-core` plugin and its native Dreaming feature are
  **disabled**. The old native `active-memory` path is retired.
- The external memory service (`memory-sebg`) is the only retrieval and
  indexing path. It combines SQLite/FTS5 lexical search with Qdrant semantic
  search (`bge-m3` embeddings) and hybrid-ranks the results.
- This adapter queries that service before each eligible reply and exposes
  `unified_memory_search` for explicit follow-up searches. It fails closed:
  on timeout or malformed data it injects nothing.

Retrieval is automatic. Promotion and archiving are separate, controlled
processes (see below).

### The three memory layers

| Layer | Who writes or maintains it | How it is used or searched |
|---|---|---|
| **Active conversation** ("session memory") | OpenClaw records the live conversation in its session store. | Used directly by the active agent session as its current transcript/context. Not part of `memory-core` or the external service. |
| **Persistent session archive** | The `session-archive-sync` automation runs every 30 minutes. `session-archive-export.py` exports eligible aged/completed sessions as Markdown and `session-archive-sync.sh` refreshes the external archive index. Active sessions, the main session, and subagent sessions are not exported. | Indexed by the external service; retrievable later with `unified_memory_search`. Archived material is historical evidence, not trusted current instructions. |
| **Curated notes and durable memory** | The agent writes ongoing facts into daily notes, and durable facts into the appropriate canonical file, when warranted. | Indexed by the external service; future sessions retrieve them through `unified_memory_search`. |

The external service indexes and retrieves all of these files. It does not
decide what gets promoted into `MEMORY.md`.

"Short-term promotion" refers only to the retired `memory-core` feature, which
tracked native recall activity and promoted selected items into `MEMORY.md`.
It does not maintain the live transcript or export old sessions. With
`memory-core` disabled, that mechanism is off. Do not add a second native
index or a parallel short-term/session database.

#### Canonical destinations for durable facts

- `USER.md`: personal facts and stable preferences
- `SOUL.md`: hard behavioral rules
- `AGENTS.md`: workflow rules
- `TOOLS.md`: environment and technical configuration
- `MEMORY.md`: only small, high-value durable context. It is kept small on
  purpose and is not a dump for conversation history.
- `memory/knowledge/<topic>.md`: detailed historical or project knowledge
- daily note: event-specific information that should not become permanent
  context

When verbose material is trimmed from a startup file, it is kept in a dated
archive such as `memory/knowledge/startup-memory-trim-YYYY-MM-DD.md`. It stays
recoverable and searchable but is no longer loaded at startup.

### Dreaming curation flow

```text
older session/dreaming material
  → curator (05:30)  → digest + canonical JSON queue
  → quality filter
  → review jobs (06:00, 06:01) → approval request
  → owner approves a specific proposal
  → manual write to the canonical owner file → indexed by the external service
```

Jobs:

| Time | Job | What it does |
|---|---|---|
| 05:20 daily | Personal fact promotion | Refreshes a registry of high-confidence, stable personal facts under `memory/facts/`. Narrow scope; does not ask for approval. |
| 05:30 daily | Dreaming curation digest | Candidate generation. Writes an advisory Markdown digest under `memory/dreaming/digests/` and the machine-readable queue `memory/review-candidates/YYYY-MM-DD-promotion-candidates.json`. Report-only: promotes nothing. |
| 06:00 daily | Dreaming candidate review 1/2 | Reads **only** the canonical JSON queue and sends an approval request for candidates that pass the quality checks. An empty queue returns `NO_REPLY` and sends nothing. |
| 06:01 daily | Dreaming candidate review 2/2 | Same as 1/2, second slot. |

The legacy `Memory Dreaming Promotion` job, which could auto-promote, is
disabled.

**What the curator looks for:** stable preferences, explicit decisions and
constraints, lessons from failures, personal facts, active projects, and
durable infrastructure decisions.

**What it rejects:** food-log noise and ephemeral status, newsletters and
reports, configuration/status blobs, clipped fragments, items without concrete
evidence, and internal control markers.

**Approval:** a review message proposes a candidate with its evidence source
and a suggested destination (for example `USER.md`, `MEMORY.md`, or
`AGENTS.md`). A candidate is never written to startup memory just because it
scored highly. Durable memory changes only after the owner approves a specific
proposal. The fact is then written to the correct canonical file with
provenance, and the existing indexing path makes it searchable.

**Never automatic:** promotion into `MEMORY.md` or any other canonical memory
or user-fact file, and any config, cron, or Gateway change. The review queue is
the only permitted delivery source. These rules exist because the old system
delivered clipped conversation fragments, stale reports, and configuration
blobs as if they were durable memories.

#### Agreed direction for candidate generation

Native Dreaming will not be re-enabled to recover candidate generation. In the
installed OpenClaw version, enabling it also schedules native promotion into
`MEMORY.md`, and there is no supported report-only mode. Instead, a separate,
report-only candidate producer backed by the external memory service and
explicitly approved source files will:

- write only a human-readable digest and review proposals, each with source,
  location, date/freshness, rationale, and suggested destination;
- never edit `MEMORY.md`, canonical memory, or user facts;
- reuse the existing review/digest delivery slots, with no duplicate review
  jobs;
- label the digest incomplete/unavailable when an input source is
  unavailable, instead of presenting an empty list as "nothing worth keeping".

### Known gaps (2026-10-04)

The inputs to the candidate digest are stale since `memory-core` was disabled:

- `scripts/dreaming-curator.mjs` reads `memory/dreaming/{light,deep,rem}/`.
  Those phase files were written by `memory-core` Dreaming; the newest is from
  2026-09-08.
- `scripts/dreaming-report-only.mjs` runs `openclaw memory promote`, which
  depends on native `memory-core` recall data.

**Until the replacement producer exists, "0 candidates" means "no input", not
"nothing worth keeping".**

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

## Development

```sh
npm test
npm run check
```

## CI

- **CI** (`ci.yml`): ESLint, syntax check, tests with coverage (≥ 99%, currently 100%), and Codecov upload.
- **Release** (`release.yml`): triggered only on version tags (`v*.*.*`); runs lint and tests, verifies the tag matches `package.json`, builds the npm package tarball, and attaches it to a GitHub Release.

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
npm test
npm run test:coverage
```

Tests use a local stub for `openclaw/plugin-sdk/plugin-entry` (see
`test/stubs/`) so the plugin entry is importable and fully covered without a
running OpenClaw Gateway. When the real `openclaw` peer package is present, it
is used instead.
