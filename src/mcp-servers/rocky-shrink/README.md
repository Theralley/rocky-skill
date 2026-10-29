# rocky-shrink

> MCP middleware. Wrap any MCP server. Cut the prose. Keep the substance.

`rocky-shrink` is a stdio proxy for the [Model Context Protocol](https://modelcontextprotocol.io). It sits between Claude (or any MCP client) and an upstream MCP server, and compresses the prose fields (`description`, etc.) using the same boundaries as the [rocky](../..) skill — preserving code, URLs, paths, and identifiers while stripping articles, filler, hedging, and pleasantries.

The result: tool catalogs that the model burns fewer tokens to read, with no change to tool semantics.

## Install

Source lives in this repo, but the npm package is not published on npm yet. The unified installer probes npm first and skips this optional MCP step cleanly when the package has no metadata.

From a local checkout:

```bash
node src/mcp-servers/rocky-shrink/index.js <upstream-command> [...args]
```

After npm publishing:

```bash
npm install -g rocky-shrink
# or run directly via npx
npx rocky-shrink <upstream-command> [...args]
```

## Use it

Wrap any MCP server in your Claude Code (or other client) config:

```jsonc
{
  "mcpServers": {
    "fs-shrunk": {
      "command": "node",
      "args": [
        "/absolute/path/to/rocky-skill/src/mcp-servers/rocky-shrink/index.js",
        "npx", "@modelcontextprotocol/server-filesystem", "/path/to/dir"
      ]
    }
  }
}
```

The proxy spawns the upstream as a subprocess, intercepts `tools/list`, `prompts/list`, `resources/list` responses, and rewrites the `description` fields (and anything else you list in `ROCKY_SHRINK_FIELDS`).

## What it does NOT touch

By design, v1 is conservative:

- **Request bodies** going to the upstream are passed through unchanged.
- **Tool call responses** (`tools/call`) are passed through unchanged. We don't want to risk silently mutating the data the upstream returns to the model.
- **Identifiers, URLs, paths, and code-looking tokens** inside any prose are preserved exactly. Same boundaries as the parent rocky skill.

## Configuration

| Env var | Default | What |
|---|---|---|
| `ROCKY_SHRINK_FIELDS` | `description` | Comma-separated list of field names to compress |
| `ROCKY_SHRINK_DEBUG` | `0` | Set to `1` to log per-field compression deltas to stderr |

## Status

Pre-1.0 — the compression rules and field set may change. The plugin is part of the [rocky ecosystem](https://github.com/Theralley/rocky-skill); see the parent repo for the full skill suite (`rocky`, `cavemem`, `cavekit`, `rockycrew`, `rocky-stats`, `rocky-init`).

## License

Apache-2.0.
