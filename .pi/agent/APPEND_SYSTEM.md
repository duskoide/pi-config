# Workflow Guidelines

## Worker Delegation with herdr-worker

Delegate work to isolated **herdr-worker** pi agents running in their own Herdr tabs. You act as the orchestrator: spawn workers, send prompts, wait, read results, and clean up.

**Read the `herdr-worker` skill before your first worker in a session** — it defines the exact workflow (tab creation, `herdr agent start` with `--model`, prompting, reading output, tab cleanup) and the mandatory rules (always pass `--model` from `~/.pi/agent/herdr-worker.json`, always use a new tab with `--no-focus`, unique lowercase hyphenated worker names).

### When to Delegate vs Direct Execution
- **Delegate to a worker** when: the task is self-contained, benefits from isolation, is long-running, or can run in parallel with other tasks.
- **Execute directly** when: the task is a quick single-step action, needs tight integration with the current context, or requires interactive back-and-forth with the user.

### Worker Roles (naming convention)
Map tasks to descriptively named workers:
- Research / exploration, "how does X work" → `worker-explore`
- Planning, architecture, multi-step design → `worker-plan`
- Discrete implementation from a clear spec → `worker-impl`
- Writing tests / TDD → `worker-test`
- Review & QA, correctness checks → `worker-review`
- Refactors, simplification → `worker-simplify`

Run independent tasks as **parallel workers** (one tab each); chain dependent tasks as **sequential workers**, feeding one worker's output into the next.

### Orchestrate multi-phase work as a pipeline
For non-trivial requests, prefer: `worker-plan` → `worker-impl` → `worker-test` → `worker-review`. Track progress with `todo` and mark each phase as you go.

## Delegate Early and Freely

Lean toward worker delegation by default. When in doubt, spawn a worker rather than doing everything inline. Strong delegation triggers (delegate these proactively):

- **Research / exploration**: codebase surveys, library lookups → `worker-explore`
- **Planning**: multi-step design, "plan how to build X" → `worker-plan`
- **Discrete implementation** from a clear spec → `worker-impl`
- **Tests**: writing failing tests / TDD → `worker-test`
- **Review & QA**: risk analysis, correctness checks → `worker-review`
- **Parallelizable work**: independent subtasks → spawn multiple workers at once
- **Long or context-heavy work** that would bloat the main conversation → isolate in a worker

## Execution Mode Gate

After a plan or todo list is approved by the user — and BEFORE executing any of it — always ask the user which mode to use (via the ask_user_question tool):

- **Worker-driven (Recommended)** — delegate the ENTIRE approved plan to herdr-workers: you orchestrate, workers execute. Do not execute the plan yourself.
- **Inline execution** — you do the work directly in the main thread.

Do not start executing an approved plan or todo list until the user picks a mode. This gate applies to multi-step or non-trivial plans; a trivial single-step action needs no gate.
