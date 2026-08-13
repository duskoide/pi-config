---
name: herdr-worker
description: Spawn worker pi agents in Herdr panes for delegated task execution. Use when you need to delegate work to isolated workers without blocking the current session.
---

# Herdr Worker

You are the orchestrator. Spawn worker pi agents in isolated Herdr panes to execute delegated tasks.

## When to Use

- Delegating implementation work to isolated workers
- Running long tasks without blocking the current session
- Parallel execution of independent tasks
- Isolating potentially destructive operations

## Settings

Worker configuration is read from `~/.pi/agent/herdr-worker.json`:

```json
{
  "defaultModel": "gpt-5-6-luna",
  "allowedModels": ["gpt-5-6-luna"],
  "defaultTimeout": 120000,
  "defaultDirection": "right"
}
```

- **defaultModel**: The model used when you don't specify one
- **allowedModels**: Models you can choose from when overriding
- **defaultTimeout**: How long to wait for worker completion (ms)
- **defaultDirection**: Pane split direction (right or down)

## Model Selection (MANDATORY)

**You MUST ALWAYS read the config file and explicitly pass `--model` when starting every worker.** Never omit the `--model` flag — workers will default to the wrong model otherwise.

1. Read `~/.pi/agent/herdr-worker.json` to get `defaultModel` (and `allowedModels`).
2. Pass `--model <model-id>` on **every** `herdr agent start` call.

You may override the default model per-worker based on task complexity, but the model must always come from the `allowedModels` list in the config:

- **Simple tasks** (formatting, basic edits): Use a faster model from `allowedModels`
- **Complex tasks** (architecture, debugging): Use a stronger model from `allowedModels`
- **Default**: Use `defaultModel` from the config — always pass it explicitly

## Workflow

### 1. Verify Herdr Environment

```bash
test "${HERDR_ENV:-}" = 1 && echo "In Herdr" || echo "Not in Herdr"
```

If not in Herdr, report the error and stop.

### 2. Create New Tab

**ALWAYS create workers in a NEW TAB, never in the current tab.** This keeps the orchestrator's tab clean and avoids cluttering the user's workspace.

```bash
herdr tab create --cwd "$PWD" --no-focus --label "worker-<short-name>"
```

Extract the new `tab_id` from `.result.tab.tab_id` and the root `pane_id` from `.result.root_pane.pane_id`.

### 3. Start Worker Agent

Start a pi worker with a unique, descriptive name. **You MUST pass `--model` every time** (read from config):

```bash
# ALWAYS pass --model explicitly from the config file
herdr agent start <unique-name> --kind pi --pane <new-pane-id> -- --model <model-id>
```

**NEVER** start a worker without `--model`. Omitting it causes the worker to use the wrong default model.

**Naming rules:**
- Lowercase letters, numbers, hyphens only
- Maximum 31 characters
- Must be unique among live agents
- Example: `worker-impl`, `worker-test`, `worker-review`

### 4. Send Prompt and Wait

Submit the task and wait for completion:

```bash
herdr agent prompt <agent-name> "<prompt>" --wait --timeout <defaultTimeout>
```

For complex tasks, increase the timeout.

### 5. Read Response

Get the worker's output:

```bash
herdr agent read <agent-name> --source recent-unwrapped --lines 100
```

### 6. Report Results

Provide:
- Pane ID where the worker ran
- Worker name and model used
- Complete response from the worker
- Any errors encountered

### 7. Cleanup (Important!)

After getting the response, close the worker's tab to free resources:

```bash
# Close the tab (this also stops the worker)
herdr tab close <tab-id>
```

**Note:** Closing the tab automatically stops any worker running in it. Only close tabs you created!

## Orchestration Patterns

### Single Worker
Delegate one task to one worker, wait for result, report back.

### Parallel Workers
Spawn multiple workers for independent tasks (each in its own tab):
1. Create tab + start worker 1
2. Create tab + start worker 2
3. Send prompts to both
4. Wait for both to complete
5. Read responses and report

### Sequential Workers
Chain workers when tasks depend on each other:
1. Spawn worker 1, wait for result
2. Use worker 1's output as input for worker 2
3. Spawn worker 2, wait for result
4. Report final outcome

## Example Usage

**Task:** "Implement a new feature and write tests"

**Orchestration:**
1. Create new tab, start `worker-impl` with `--model claude-sonnet-5` (complex reasoning) to implement the feature
2. Wait for implementation to complete
3. Read the implementation result
4. Create new tab, start `worker-test` with `--model gpt-4o` (faster, sufficient for test writing) to write tests
5. Wait for tests to complete
6. Read test results
7. Report: "Implementation completed by worker-impl in tab w7:t2. Tests written by worker-test in tab w7:t3. Both passed validation."
8. Cleanup both tabs

## Important Notes

- **ALWAYS pass `--model <model-id>` from the config file when starting workers.** Never omit it.
- **ALWAYS create workers in a new tab** (`herdr tab create`), never split panes in the current tab.
- Always use `--no-focus` to keep the user's focus on the orchestrator pane/tab
- Use unique worker names to avoid conflicts
- The spawned worker has access to the same tools and context as the orchestrator
- For very long tasks, consider using `--timeout` with appropriate values
- If reading output fails (alternate screen), ask the worker to write results to a file and read that instead
- Choose models strategically: faster models for simple tasks, stronger models for complex reasoning
