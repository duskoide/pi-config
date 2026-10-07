---
name: pi-subagent
description: Delegate bounded read-only work to local Pig children.
---

# Local Pig delegation

This is the Pig adapter, not Pi's Herdr-backed checked graph runner.

- Use `delegate_task` with `mode: direct` for bounded read-only tasks.
- Available roles: `scout`, `reviewer`, `researcher`. Never use an implementer or
  writing role in direct mode.
- Use one `{role, name, task}` packet, `tasks` for independent packets, or `chain`
  with `{previous}` for dependent read-only questions. Limit each workflow to
  eight packets. A shared limiter allows three active children.
- Give an outcome, allowed scope, exclusions, and expected evidence in `task`.
  Explicitly exclude credentials and unrelated files when appropriate.
- Workers use Pig's built-in `read`, `grep`, `find`, and `ls`. Ambient extensions,
  skills, context files, recursive delegation and project approval are disabled.
  Inference-provider adapters may be explicitly loaded. This is tool-level
  restriction, not an OS sandbox.
- In TUI/RPC mode the tool returns a local handle and delivers one follow-up.
  Do complementary work or end the turn; never poll merely to wait. In headless
  print/JSON mode it awaits the children and returns their results directly.
- Explicit `model` must be `provider/model`. Explicit `modelClass` uses the
  `/task-models` profile or a `pig-port.json` override. Missing routes fail;
  there is no silent fallback to the current model.
- Use `/subagent` to inspect local tasks, `/subagent show <id>` for retained
  results, and `/subagent cancel <id>` to cancel a local workflow. Handles are
  session-scoped, not durable recovery identities.
- Session shutdown cancels and drains owned workers.
- **Isolated/write-capable requests are unavailable and rejected.** Keep writing,
  checks, review decisions and integration in Main. Do not claim the original
  `subagent_stage`/`subagent_integrate` safety contract or silently downgrade an
  isolated request to direct mode.
