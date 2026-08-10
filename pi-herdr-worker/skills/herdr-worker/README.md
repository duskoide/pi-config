# Herdr Worker

Spawn worker pi agents in isolated Herdr panes for delegated task execution. The primary agent acts as orchestrator, delegating work to workers.

## Quick Start

### Slash Commands

```bash
# Spawn worker with default model (from settings)
/worker Implement the login page

# Spawn worker with specific model
/worker Review code worker-review claude-sonnet-4-5

# Spawn worker with model and custom timeout (ms)
/worker Build project worker-builder gpt-4o 300000

# Quick spawn (auto-generated name, default model)
/workerp Run the linter and fix errors

# Quick spawn with model override
/workerp Check security vulnerabilities gpt-4o-mini

# List running workers
/workerlist

# Kill a specific worker
/workerkill worker-test-runner
```

### The `spawn_worker` Tool

```
spawn_worker({
  prompt: "Run tests and report any failures",
  name: "worker-tests",
  model: "gpt-4o",
  timeout: 180000,
  direction: "right"
})
```

### Shell Script (CLI)

```bash
~/.pi/agent/bin/herdr-worker.sh <agent-name> "<prompt>" [--model <model>] [--timeout <ms>]

# Example:
~/.pi/agent/bin/herdr-worker.sh worker-test "Run npm test and report results"
~/.pi/agent/bin/herdr-worker.sh worker-review "Review the diff" --model claude-sonnet-5 --timeout 180000
```

---

## Available Slash Commands

| Command | Usage | Description |
|---------|-------|-------------|
| `/worker` | `/worker <prompt> [name] [model] [timeout]` | Spawn worker with full control |
| `/workerp` | `/workerp <prompt> [model]` | Quick spawn with auto-generated name |
| `/workerlist` | `/workerlist` | List all running workers |
| `/workerkill` | `/workerkill <name>` | Kill a specific worker |

---

## Settings

Configuration lives at `~/.pi/agent/herdr-worker.json`:

```json
{
  "defaultModel": "claude-sonnet-5",
  "allowedModels": ["gpt-4o", "claude-sonnet-5", "claude-sonnet-4-5", "gpt-4o-mini"],
  "defaultTimeout": 120000,
  "defaultDirection": "right"
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultModel` | string | `claude-sonnet-5` | Model used when no override is specified |
| `allowedModels` | string[] | see above | Models the orchestrator can choose from |
| `defaultTimeout` | number | `120000` | Default wait timeout in milliseconds |
| `defaultDirection` | `"right"` \| `"down"` | `"right"` | Default pane split direction |

Edit this file to change the default worker model or add/remove allowed models.

---

## How It Works

1. **Creates a new pane** — Splits the current pane for an isolated terminal
2. **Starts a pi worker** — Launches a pi instance with the chosen model
3. **Sends the prompt** — Submits the task and waits for completion
4. **Reads the response** — Gets the worker's output
5. **Cleans up** — Closes the pane and stops the worker automatically

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | required | The task to send to the worker |
| `name` | string | auto-generated | Unique worker name (lowercase, hyphens, max 31 chars) |
| `model` | string | from settings `defaultModel` | Model ID (e.g., `gpt-4o`, `claude-sonnet-5`) |
| `timeout` | number | from settings `defaultTimeout` | Timeout in milliseconds |
| `direction` | `"right"` \| `"down"` | from settings `defaultDirection` | Pane split direction |

## Orchestration Patterns

### Single Worker
Delegate one task, wait for result, report back.

### Parallel Workers
Spawn multiple workers for independent tasks simultaneously.

### Sequential Workers
Chain workers when tasks depend on each other's output.

## Requirements

- Pi must be running inside a Herdr-managed pane (`HERDR_ENV=1`)
- Herdr must be installed and running
- Settings file at `~/.pi/agent/herdr-worker.json`

## Troubleshooting

### "Not running in Herdr environment"
Pi must be launched from within a Herdr session.

### "Model not in allowedModels"
The requested model isn't in your settings file. Add it to `allowedModels` or use one of the existing entries.

### Timeout exceeded
Increase timeout: `spawn_worker({ prompt: "...", timeout: 600000 })` (10 minutes).
