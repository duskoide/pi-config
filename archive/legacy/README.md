# Archived legacy configuration

These files were part of the previous Pi setup but are not loaded by the current
configuration. They are retained for rollback/reference during this reset:

- `patch-pi-permission-system.mjs`, `pi-permission-system-config.json`, and
  `pi-permission-system-extension-config.json` belong to the removed
  `@gotgenes/pi-permission-system` setup.
- `herdr-permission-bridge.ts` depends on that removed permission event surface.
- `subagents.json` belongs to the former `@tintinweb/pi-subagents` configuration;
  current `pi-subagents` settings live in `.pi/agent/settings.json` and agent files.
- `pi-better-openai.json` is retained as a disabled machine-local extension config.

Nothing in this directory is referenced by the Pi package manifest.
