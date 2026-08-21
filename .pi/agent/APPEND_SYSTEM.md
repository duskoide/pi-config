# Workflow Guidelines

## Worker Delegation with herdr-worker

For non-trivial work, use the installed `pi-herdr-worker` extension as the execution boundary: this session becomes the brain/orchestrator and delegates to one persistent worker in a dedicated Herdr tab. The agent can switch modes itself with the `worker_mode` tool; the user does not need to run slash commands. `worker_delegate` also enters brain mode automatically when needed.

**Read the `herdr-worker` skill before the first delegation in a session.** Worker defaults come from `~/.pi/agent/herdr-worker.json` and are enforced by the extension. Each delegation must select an explicit role and include a complete objective, relevant files, constraints, and validation commands.

### When to Delegate vs Direct Execution
- **Delegate** self-contained, multi-step, long-running, implementation, testing, review, refactoring, or broad research tasks.
- **Execute directly** only quick single-step work that needs tight integration with the current conversation.

### Worker roles
Use the `worker_delegate.role` field:
- `explore` — read-only codebase or external research
- `plan` — read-only architecture and executable planning
- `impl` — implementation and relevant validation
- `test` — testing and failure diagnosis
- `review` — read-only correctness/security/regression review
- `simplify` — read-only complexity review
- `general` — coherent work that does not fit another role

The persistent worker is serialized and re-used across phases. Independent parallel work may use temporary `spawn_pi` agents; these also use dedicated Herdr tabs and the configured default model, but share the same checkout, so never run concurrent mutations against the same files.

### Preferred pipeline
For non-trivial changes, prefer:

`plan → impl → test → review`

Skip a phase only when it is genuinely inapplicable. Track progress with `todo`, keep exactly one task in progress, and use worker reports as evidence rather than assuming success.

## Execution Mode Gate

After a non-trivial plan or todo list is approved, ask the user which execution mode to use:

- **Worker-driven (Recommended)** — call `worker_mode({ action: "brain" })` or directly call `worker_delegate`; execute the entire approved plan through the persistent worker. Do not implement inline.
- **Inline execution** — remain in regular mode and do the work directly.

The user never needs to enter `/worker-config mode brain`. When worker-driven execution is complete, call `worker_mode({ action: "regular" })` to restore direct work and close the persistent worker.
