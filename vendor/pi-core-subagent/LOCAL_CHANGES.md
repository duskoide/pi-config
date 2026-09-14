# Local changes

Upstream: `@arhen/pi-core-subagent` 1.3.54 (MIT), vendored from the installed Pi package.

This copy is loaded explicitly by the root `pi-config` package. Local changes:

- Prefer an exact case-insensitive agent filename-stem match before falling back to description matching.
- Allow `web_search` and `web_fetch` in read-only agent-file tool lists without making those tasks write-capable.
- Lazily capture those two tool definitions from `@juicesharp/rpiv-web-tools` and pass only requested definitions to child sessions as SDK custom tools.
- Keep child extension discovery disabled (`noExtensions: true`).
- Validate explicit per-task tool names and require `write: true` for `bash`, `edit`, or `write`.

The upstream npm package must not be loaded at the same time or it will register duplicate subagent tools and commands.
