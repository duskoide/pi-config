# Configuring pi-delegator

This checkout manages `@mostlyworks/pi-delegator@0.6.6` with five complete
standard profiles in `.pi/agent/pi-delegator.json`. The role prompts in
`.pi/agent/delegator/` are unchanged copies from that release, distributed under
[the upstream MIT license](../.pi/agent/delegator/LICENSE).

## Installation and checks

`./install.sh` links the JSON file and the dedicated prompt directory into the
Pi agent directory (`~/.pi/agent` by default, or `PI_CODING_AGENT_DIR`). Prompt
paths are relative to the JSON file's location, so both links are necessary.
They do not depend on the checkout's absolute location or on Pi's npm cache.

```bash
npm run check:delegator
npm test
./install.sh
```

The standalone check validates bounded UTF-8 JSON, complete profile fields,
models/thinking/deadlines, prompt files, tool lists, and explicit local capability
paths without network access, credentials, or an installed Pi package. Pass an
installed JSON path to check its prompt resolution as well:

```bash
node scripts/check-pi-delegator.mjs "$HOME/.pi/agent/pi-delegator.json"
```

`npm run check:config` also incorporates these checks when the package or its
configuration is present. It additionally checks unrelated provider/failover
policy. The installed extension remains authoritative for runtime configuration
validation and provider availability. **Restart Pi after changes**: effective
profiles are immutable for a session.

## Baseline and current settings

The starter profiles used `model: null`, `deadlineMs: null`, `skills: []`, and
`extensions: []`, with scout at `low` thinking and the other profiles at `high`.
Model/thinking choices are intentionally editable: `.pi/agent/pi-delegator.json`
is the source of truth for current selections, including any changes saved by
`/delegator-config`. When model is null it comes from the active parent session,
not the legacy `subagents.defaultModel` setting.

Scout and oracle have read, grep, find, and ls. Reviewer and tester also have
bash. Worker additionally has edit and write. Only worker's prompt permits
source edits. Bash-enabled delegates are not write-protected; this is not a
sandbox. Their no-edit restrictions are instructions.

## Interactive primary and fallback editor

The local extension provides:

```text
/delegator-config
/delegator-config oracle
/delegator-config oracle fallback
```

If the command is not yet visible in a running session, use `/reload` to discover
it (or restart Pi). Choose a profile and whether to configure its primary
model/thinking or its initial fallback. Type to search models and confirm the
displayed destination file. The primary editor also offers a thinking level. “Inherit parent model” saves
`model: null`; an existing unavailable model can also be kept unchanged. The
picker uses Pi's cached available-model snapshot: it does not refresh providers,
call a model, or change the active parent's model/thinking.

The editor lists enabled, complete entries already declared in user and trusted
project JSON. A project replacement is edited in the project file; otherwise
the global file is edited. Untrusted project files are ignored. Disabled or
undeclared bundled profiles are not implicitly enabled or synthesized. Install
the managed configuration first if there are no editable profiles.

Esc or declining confirmation saves nothing. Saving changes only model and
thinking, preserves all other profile fields, and follows the managed symlink
instead of replacing it. Concurrent changes to the selected model/thinking
cause a conflict error rather than being overwritten. **Restart Pi after saving**
to apply the immutable delegate registry. Pi can clamp unsupported thinking
levels. Available parent models may still need explicit provider extensions in
a delegate; the editor warns about this and never changes capabilities for you.

This command is TUI-only; edit JSON directly in headless/RPC mode.

## Initial agent failover (opt-in)

Current managed profiles explicitly load `delegator/qoder-provider.ts`, which
locates the installed `pi-provider-qoder` in the machine's Pi package cache.
This repairs Qoder availability in children: upstream passes `--no-extensions`,
so a Qoder model name alone could not start an agent. The bridge is child-only;
its paths are portable through the already-linked `delegator/` directory.
Qoder's own startup may perform catalog/auth network operations even in offline
mode; the adapter does not change or bypass that provider behavior.

Each profile also explicitly loads its own `delegator/runtime/<name>.ts` shim.
The shims identify roles exactly and share one guarded child implementation for
**both foreground `delegate` and background `delegate_start`**, without changing
the pinned runner. The sidecar `delegator/failover.json` has an empty `profiles`
map by default: **all automatic fallbacks remain disabled until you choose them**.

Use `/delegator-config <profile> fallback` (or the action chooser) for each
managed global role. “No automatic failover” disables that role. The sidecar
stores the primary selection to which the fallback is bound; changing the
primary or supplying a different explicit model override disarms that binding.
Reconfigure the fallback after a primary change. `model: null` bindings follow
the inherited primary. Project-specific replacements remain editable in the
primary editor; these managed global adapters do not own project-local fallback
configuration. Fallback edits never rewrite the primary profile JSON.

There is at most **one model switch**, after an initial remote rate/quota/auth
or selected temporary-provider failure, before any assistant text, thinking,
tool-call content, or tool execution. Setup/missing-model/auth-configuration
errors, context overflow, cancellation, malformed/protocol errors and tool
failures never cause a switch. Missing fallback models/credentials retain the
original failure. Native Pi retry/compaction policy still applies first; this
is not a promise of exactly two API requests. No child relaunch or deadline
reset occurs. A successful fallback stays selected for the rest of that child.
Other extension-provided fallback models still require explicit provider loading.

Both attempts retain native usage; background retrieval reports it once as
usual. The final answer identifies the actual fallback in an `Initial agent
failover` note. Parent receipt/result **model metadata still names the requested
primary**, because the upstream protocol does not expose physical model changes;
do not treat that field as proof no switch occurred. Child JSON identifies the
physical model. The main session's provider/failover policy is untouched.

Offline regression checks use synthetic streams; the native smoke runs isolated
Pi children and the real pinned foreground/background runners against loopback
providers, not live Qoder/Codex inference:

```bash
npm test
npm run check:delegator
npm run check:agent-failover
```

Restart Pi to load the changed immutable profile capabilities. New children
capture their fallback policy at startup; saving it does not reroute existing
jobs. Retrieve current background results before restarting.

## Customize a profile

Edit the complete profile in `.pi/agent/pi-delegator.json`. For example, a full
oracle replacement is:

```json
{
  "profiles": {
    "oracle": {
      "description": "Independent architecture advice",
      "displayName": "Architecture Advisor",
      "model": "openai-codex/gpt-6.1-sol",
      "thinking": "xhigh",
      "prompt": "delegator/oracle.md",
      "tools": ["read", "grep", "find", "ls"],
      "skills": [],
      "extensions": [],
      "deadlineMs": null
    }
  }
}
```

This is a replacement example, not a patch: description, model, thinking,
prompt, tools, skills, and extensions are all required. Profiles are never
field-merged. Keep the other explicit entries in this repository if you want
their managed prompt copies to remain in use. Omitted names fall back to
lower-precedence definitions.

- `model` is `null` or a Pi model selector. A per-call model override takes
  precedence over the profile, then the active parent model.
- `thinking` is off, minimal, low, medium, high, xhigh, or max. Pi may clamp it to
  the selected model's capabilities. Thinking is not a per-call argument.
- `prompt` names a non-empty UTF-8 Markdown file, at most 64 KiB; it is not
  inline prompt text. For a portable custom prompt, put it in `delegator/`.
- `tools` is a non-empty, unique list. Nested `delegate` calls are forbidden.
- `skills` and `extensions` list existing explicit local paths, not npm/git/URL
  sources. Skills are Markdown files or directories; extensions are JS/TS
  files. Use relative paths or absolute paths, not shell `~` expansion.
- `displayName` is optional and affects only the human-facing label.
- `deadlineMs` is optional. Omitted or null means no overall deadline; a positive
  integer enables one, up to 2,147,483,647 ms. For example, 600000 is ten minutes.

Delegates do not inherit ambient extensions or skills. An extension-provided
model provider may require its provider extension explicitly listed in the
profile; a model name alone does not load that extension. Built-in providers can
use machine-local Pi authentication. Do not commit credentials.

## Disable or add profiles

Set an entry to null to disable it, for example `"tester": null` within the
profiles map. Add a complete entry under a new lowercase name (letters, digits,
underscores, and hyphens, beginning with a letter) to add a custom delegate.

Trusted projects can define complete replacements or disabled entries in
`<project>/.pi/pi-delegator.json`. Precedence is project → user → bundled.
Untrusted project files are ignored. A delegate call's `cwd` does not select a
different profile configuration; discovery uses the parent session's directory.

The legacy `.pi/agents/`, `.pi/agent/agents/`, and `settings.json`'s `subagents`
block are retained separately and do not configure this extension.

## Background delegation

The local `extensions/delegator-background/` bridge adds three model-callable
tools while leaving upstream foreground `delegate` unchanged. Run `/reload` to
discover them in an already-running session. **Reload also cancels existing
background delegates and discards their in-memory results**: retrieve anything
needed before changing sessions or reloading.

```ts
delegate_start({
  agent: "scout",
  task: "Find the authentication implementation and report relevant files."
})
// Returns a taskId immediately; start other independent agents and continue work.
delegate_result({ taskId: "del-<id from the launch receipt>" })
delegate_cancel({ taskId: "del-<id from the launch receipt>" })
```

`delegate_start` accepts agent, task, optional model/cwd, and optional
`notifyOnCompletion`/`triggerOnCompletion` booleans. A task must be nonblank and
at most 32 KiB. It captures the selected profile, thinking, model selector, and
working directory at launch. Model precedence is per-call override → profile →
active parent; thinking and any optional deadline remain profile-owned. Relative
cwd resolves from the parent directory, and choosing another cwd does not select
another profile configuration. Profiles come from the same trusted-project/user/
bundled precedence used by foreground delegation, fixed for the session.

Default completion sends one hidden typed follow-up notification to the model
and wakes it if idle, or queues a follow-up if busy. It does not add a visible
completion block to the chat: the statusline reports the state instead. The main session can execute other
work or start multiple agents without waiting for their answers. Tool guidelines
and the conditional `pi_config_tool_routing` system-prompt section explicitly
permit several `delegate_start` calls in one turn when authorized work splits
into independent subtasks (within the eight-active-job cap). Foreground
`delegate` is for an answer needed before proceeding; background fan-out is not
a default for trivial/tightly coupled work or when the user asks not to delegate. With
`triggerOnCompletion: false`, delivery is notification-only. With
`notifyOnCompletion: false`, both notification and default wake are disabled;
explicitly enabling wake without notifications is rejected. SDK send failures
are not durable-delivery acknowledgments; the job/result state remains available.

After a terminal notification, retrieve the answer once with `delegate_result`.
It never waits: while running it returns a not-ready snapshot. Omitting taskId
lists all current jobs and limits. Do not repeatedly query either form to wait
while automatic notifications are pending. A completed delegation is not proof
that the feature/test/task passed: read the actual report. Failed/cancelled
results retain bounded failure and cleanup evidence. Truncation and forced
cleanup are reported explicitly.

`delegate_cancel` requests cancellation and returns immediately; `cancelling`
means cleanup is still underway. Verify terminal state/cleanup via its completion
notification/result. Cancelling an already-finished job leaves its answer intact.
Before Pi records a launch's tool result, cancellation of that tool cancels the
launch; afterward the job owns its own AbortController and ordinary parent-turn
cancellation does not stop it.

### Ownership, bounds, and costs

- At most eight jobs run concurrently, including jobs cleaning up. There is no
  hidden queue or mandatory run deadline.
- The buffer retains at most 32 jobs. Starting more can evict retrieved terminal
  results, but never unread results. If all entries are unread, fetch completed
  results before starting more jobs. Re-reading a retained answer is supported.
- Child token/cost usage is attached to the parent tool result on the first
  terminal answer retrieval only, including failure/cancellation; listing or
  repeated reads do not double-count. Unretrieved usage is not added to parent
  totals. The provider still charges for work already performed.
- Final answers are bounded to 50 KiB; failure messages to 8 KiB and stderr tails
  to 16 KiB. This bridge does not retain full transcripts or output artifacts.
- Results are session-owned, not persisted or resumable. Retrieved answers remain
  in ordinary parent conversation history, but old IDs do not work after teardown.
- Session shutdown (quit, reload, new, resume, fork, and teleport's teardown path)
  disables further notifications, aborts all running children, and awaits the
  pinned POSIX runner's cleanup. Cleanup diagnostics are surfaced. SIGKILL,
  crashes, emergency exits, SDK disposal without the lifecycle hook, and
  deliberate subprocess session escape are not guaranteed to clean up.

Use disjoint file ownership or explicit separate worktrees for concurrent workers
and parent changes. Read-only agents inspect live files; avoid mutating their
scope until retrieval unless the task explicitly permits it. No automatic
worktree, filesystem sandbox, retained child session, or parent conversation
projection is added. Roles, tools, ambient-extension/skill isolation, provider
availability, and instruction-based no-edit restrictions are identical to the
foreground runner. Self-loading the bridge or enabling nested delegation tools
in a profile is rejected; the private child marker also disables its registration
inside normal delegate children. This is a recursion guard, not a security sandbox.

These task IDs are separate from `bg_run`/`bg_result` and do not enter the existing
`/bg` dock. A reserved `Agents` statusline widget below the editor reports their
activity independently of the active footer's layout. Use the three delegate
tools for state and cancellation.

### Quiet agent statusline

Agent activity belongs in the footer rather than repeated chat blocks:

```text
Agents · scout:read · reviewer:bash · worker:done
```

A tool name is the most recent observed activity, not proof that a tool is still
running. `...` means running without a tool start yet; `done`, `error`, `stopping`,
and `cancelled` represent job lifecycle states. A duplicate agent type gains a
collision-checked short `#id`; distinct names that truncate to the same label
also gain IDs. `+N` indicates additional agents beyond the compact preview.
Failed unread jobs have display priority. The summary uses the actual widget
width (up to eight entries), shortens the preview as needed, and falls back to
counts on narrow terminals. It reserves its own single row, so crowded Powerline
segments cannot drop it. Completed
entries disappear after their result is retrieved; the entire item hides when
nothing is running or unread.

Routine launch/cancel tool rows and not-ready results render invisibly while
collapsed. Terminal result retrieval shows a single compact row; tool-operation
errors remain visible. Expand tools using Pi's normal expansion control for the
full original arguments, metadata, and answer. Only presentation changes:
model-facing tool content/usage and follow-up notifications are retained. The
main model is also instructed not to narrate routine per-agent lifecycle events.

The widget owns key `delegators` with `placement: "belowEditor"` and renders no
row when idle. No extension-status text or Powerline custom item is published,
so there is no duplicate aggregate-status/notification row. No existing footer
layout is replaced. Other footer settings and agent model/thinking choices
remain independent.

The bridge imports the installed `@mostlyworks/pi-delegator@0.6.6` profile loader
and subprocess runner from the global Pi npm cache without modifying them.
It deliberately fails on a different package version: review/test the private
API bridge before upgrading the pin. Linux/macOS are supported, with the same
macOS Python 3 and process-control requirements as upstream.

## Foreground use and limits

Ask Pi, for example: “Use the reviewer delegate to review the current diff.”
Each original `delegate` call runs one fresh foreground Pi subprocess.
Independent foreground calls can run concurrently, but upstream itself has no
nested agents, retained sessions, resume, or background mode. The local bridge
above adds session-owned background jobs without altering that foreground tool. Tasks are limited to 32 KiB and returned
text to 50 KiB. A valid returned answer means delegation completed, not that the
requested task necessarily passed; read its verdict and evidence.

Upstream reference: [user profile configuration](https://github.com/itmostlyworks/pi-delegator/blob/v0.6.6/docs/REQUIREMENTS.md#user-profile-configuration).
