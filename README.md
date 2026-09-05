# OpenClaw Memory Adapter

An external OpenClaw plugin that retrieves bounded memory context from an HTTP
memory service. It is deliberately separate from OpenClaw's bundled memory
indexer and never invokes indexing.

## Behavior

- Calls `POST {endpoint}/search` with `{ "query": "...", "limit": 5 }`.
- Adds normalized results to `before_prompt_build` as reference context.
- Uses a short timeout and fails closed when the service is unavailable.
- Supports agent/chat allowlists.
- Does not search archives automatically and never calls `/index`.

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
          "maxResults": 5
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
