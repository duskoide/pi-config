# pi-herdr-worker

Spawn worker [pi](https://pi.dev) agents in isolated [Herdr](https://github.com/ogulcancelik/herdr) tabs for delegated task execution. The primary agent acts as orchestrator, delegating work to isolated workers.

## Install

```bash
pi install npm:@duskoide/pi-herdr-worker
```

## Requirements

- pi must be running inside a Herdr-managed pane (`HERDR_ENV=1`)
- Herdr must be installed and running
- Settings file at `~/.pi/agent/herdr-worker.json` (optional — sensible defaults are built in)

## Slash Commands

| Command | Usage | Description |
|---------|-------|-------------|
| `/worker` | `/worker <prompt> [name] [model] [timeout]` | Spawn worker with full control |
| `/workerp` | `/workerp <prompt> [model]` | Quick spawn with auto-generated name |
| `/workerlist` | `/workerlist` | List all running workers |
| `/workerkill` | `/workerkill <name>` | Kill a specific worker |

### Examples

```bash
/worker Implement the login page
/worker Review code worker-review gpt-5-6-luna
/workerp Run the linter and fix errors
/workerlist
/workerkill worker-test-runner
```

## The `spawn_worker` Tool

```ts
spawn_worker({
  prompt: "Run tests and report any failures",
  name: "worker-tests",
  model: "gpt-5-6-luna",
  timeout: 180000,
  direction: "right"
})
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | required | The task to send to the worker |
| `name` | string | auto-generated | Unique worker name (lowercase, hyphens, max 31 chars) |
| `model` | string | from settings | Model ID, launched through the Kiro provider at maximum thinking |
| `timeout` | number | `120000` | Timeout in milliseconds |
| `direction` | `"right"` \| `"down"` | `"right"` | Pane split direction |

## Settings

Configuration lives at `~/.pi/agent/herdr-worker.json`:

```json
{
  "defaultModel": "gpt-5-6-luna",
  "allowedModels": ["gpt-5-6-luna"],
  "defaultTimeout": 120000,
  "defaultDirection": "right"
}
```

## How It Works

1. Creates a new isolated Herdr tab
2. Launches a pi worker in the tab's root pane using Kiro's `gpt-5-6-luna` model at maximum thinking
3. Submits the task and waits for completion
4. Reads the worker's output
5. Closes the tab and stops the worker automatically

## License

MIT
