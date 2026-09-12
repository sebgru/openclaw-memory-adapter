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
