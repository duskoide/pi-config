# Workflow Guidelines

## Agent Delegation & Workflow Management

When working on multi-step tasks or complex workflows, prefer using the **pi-open-agents** system for delegation and workflow orchestration:

### Subagent Delegation
- Use `subagent({ agent: "<name>", task: "<task>" })` to delegate discrete tasks to specialized subagents
- Available subagents are auto-discovered from `.pi/agents/` and `~/.pi/agent/agents/`
- Each subagent runs with its own model, thinking level, and permissions
- Use delegation for:
  - Isolated tasks that benefit from focused context
  - Parallel work streams
  - Tasks requiring different model capabilities (e.g., fast local model for simple tasks, strong model for complex reasoning)

### Workflow Orchestration
- For complex multi-phase workflows (planning → execution → review), consider creating dedicated agents:
  - **Planner agent**: read-only exploration and plan generation
  - **Executor agent**: implementation with full tool access
  - **Reviewer agent**: code review and validation
- Define agents in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global) using OpenCode-compatible `.agent.md` format
- Switch between agents with `/agent <name>` to change the primary agent mode

### When to Delegate vs Direct Execution
- **Delegate** when: task is self-contained, benefits from isolation, or can run in parallel
- **Execute directly** when: task requires tight integration with current context, quick single-step action, or interactive exploration

### Agent Configuration
Each agent can define:
- `model`: specific model to use (e.g., `claude-sonnet-4-5`, `lm-studio/qwen-2.5-coder`)
- `thinking`: thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`)
- `mode`: `all` (default), `subagent` (delegation only), or `primary` (main agent only)
- `permission`: tool access rules (e.g., `read, bash, edit` or glob patterns)

Example agent definition (`.pi/agents/planner.md`):
```markdown
---
name: planner
description: Read-only exploration and planning
model: claude-sonnet-4-5
thinking: high
mode: all
permission:
  read: allow
  bash: allow
  edit: deny
  write: deny
---

You are a planning specialist. Analyze code, explore the codebase, and create detailed implementation plans. Do not make changes - focus on understanding and planning.
```

## Delegate Early and Freely

Lean toward subagent delegation by default. When in doubt, delegate rather than do everything inline.

### Strong delegation triggers (delegate these proactively)
- **Research / exploration**: codebase surveys, "how does X work", library lookups → `explore`
- **Planning**: multi-step design, architecture, "plan how to build X" → `planner`
- **Discrete implementation** from a clear spec → `coder` or `make`
- **Tests**: writing failing tests / TDD → `test`
- **Review & QA**: risk analysis, correctness checks → `reviewer` or `check`
- **Refactors**: spotting/fixing overengineering → `simplify`
- **Parallelizable work**: independent subtasks that can run concurrently → fire multiple subagents at once
- **Long or context-heavy work** that would bloat the main conversation → isolate in a subagent

### Session choice
- `session: "fork"` — when the task depends on this conversation or prior context.
- default (`"none"`) — for self-contained, fully-specified tasks.

### Orchestrate multi-phase work as a pipeline
For non-trivial requests, prefer: `planner` → `coder`/`make` → `test` → `reviewer`/`check`.
Track progress with `todo` and mark each phase as you go.

### Still do directly
- Quick single-step actions, trivial edits, interactive back-and-forth, or anything needing tight live integration with the current context.

## Execution Mode Gate

After a plan or todo list is approved by the user — and BEFORE executing any of it — always ask the user which mode to use (via the ask_user_question tool):

- **Subagent-driven (Recommended)** — delegate the ENTIRE approved plan to the `orchestrator` subagent via `subagent({ agent: "orchestrator", task: "<the approved plan>", session: "fork" })`. Do not execute any of it yourself and do not call worker subagents directly — the orchestrator coordinates all of it.
- **Inline execution** — you do the work directly in the main thread.

Do not start executing an approved plan or todo list until the user picks a mode. This gate applies to multi-step or non-trivial plans; a trivial single-step action needs no gate.
