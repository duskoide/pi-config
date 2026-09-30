# Tool routing audit

## Findings

Audited the installed Pi 0.99.1 environment, not just package declarations:

| Tool | Installed package | Existing routing | Recommendation |
| --- | --- | --- | --- |
| `sudo_task` | `pi-herdr-sudo-task` 0.1.5 | Tool description, prompt snippet, and three explicit proactive/consent guidelines. Only registers in the required Herdr environment. | Keep existing guidance and both consent gates; no extra prompt rules needed. |
| `teleport` | `pi-agent-teleport` 0.2.1 | Description explains session movement and owned worktree actions; registration has no `promptSnippet` or `promptGuidelines`. | Add a short conditional reminder distinguishing session movement from external file reads and subagent checkout ownership. |
| `delegate_task` | `@henryqw/pi-subagent` 24.0.1 | Description lists Roles, with a snippet and mode/safety/model-class guidelines. These explain how to delegate but do not strongly trigger proactive scouting or review. | Add explicit opportunity triggers without quotas, automatic launches, or weaker checks. |

Primary installed-source evidence:

- `~/.pi/agent/npm/node_modules/pi-herdr-sudo-task/dist/index.js:639–651`
- `~/.pi/agent/npm/node_modules/pi-agent-teleport/src/index.ts:152–167`
- `~/.pi/agent/npm/node_modules/@henryqw/pi-subagent/extensions/subagent.ts:453–462`
- `~/.pi/agent/npm/node_modules/@henryqw/pi-subagent/skills/pi-subagent/SKILL.md`

A bounded read-only `delegate_task` scout completed this audit successfully. This
confirms one actual launch/result path worked; it does not prove every provider
route or isolated implementation path works.

## Effective subagent configuration

The current runner uses built-in `scout`, `reviewer`, and `implementer` Roles plus
any user Roles under `~/.pi/agent/config/pi-subagent/`. No user Role/config
overrides were present at audit time. Scout and reviewer have read-only base tools
and no extension/skill/MCP resources; implementer is write-capable and requires
isolated mode. Built-ins do not set a model-class default; the delegation task
registration defaults to `fast`.

Task model routes are configured in
`~/.pi/agent/config/pi-task-models/config.json`, not `settings.subagents`:

- `fast` and `balanced`: primary `openai-codex/gpt-6-luna`.
- `frontier`: primary `openai-codex/gpt-6-astra`.
- `fav`: primary `qoder/GLM-5.3`.

These are static routing observations, not credential/provider availability
checks. No credentials or private worker/session transcripts were read.

The retained `.pi/agents/` profiles and `settings.subagents` block belong to a
previous runner and do not configure this runner. The existing README's claim
that no runner is loaded is stale relative to the installed/selected package.
Those existing user-edited files were left untouched.

## Local improvement

`extensions/tool-routing.ts` adds one named `pi_config_tool_routing` system-prompt
section from `before_agent_start`, conditional on selected tools. It encourages:

- Proactive early scouts for unfamiliar-code, cross-component, and multi-part work.
- Independent reviewers for meaningful code changes.
- Parallel independent read-only investigations while Main does complementary work.
- Configured `delegate_task` Roles and the packaged skill for these workflows.
- Direct mode only for read-only work; isolated mode for implementation/writing.
- Keeping trivial work local and honoring requests not to delegate.

The extension does not launch workers, register new tools, alter tool selection,
rewrite existing tool descriptions/guidelines, configure providers, or modify
permission and integration checks. `sudo_task` gets no duplicate guidance.

The existing local package loads `./extensions`, so no manifest or installed
package changes are needed. Run `/reload` in Pi to load the new extension.

This uses Pi's verified structured prompt API. On older Pi versions without
`systemPromptOptions`, it safely does nothing rather than replacing the whole
prompt. The repository installer now defaults to the Pi `latest` dist-tag, so a fresh
install picks this up; an installation made when the default was the older 0.85.1 pin
does not, so do not assume this improvement is enabled there without checking
`pi --version`. It is verified against installed Pi 0.99.1.
A later extension forcing a full prompt replacement can also supersede section
contributions.

## Baseline verification and known blocker

Before changing files:

- `npm test`: **10/10 passed**.
- `npm run check:config`: **failed** because fallback
  `commandcode/Qwen/Qwen3.8-27B` is absent from `settings.enabledModels`.
- Config warnings also include six unpinned packages, `defaultProjectTrust:
  "always"`, disabled HTTP idle timeout, and the default provider being outside
  managed failover discovery.

After the routing change:

- Focused routing tests: **7/7 passed**.
- Full `npm test` suite: **17/17 passed**.
- Installed Pi 0.99.1 `loadExtensions` and `buildSystemPrompt` smoke: **passed**;
  confirmed the routing section appears for active tools and disappears when
  those tools are deselected, while preserving an unrelated section.
- `git diff --check`: **passed**.
- An independent read-only `delegate_task` reviewer returned **PASS**; no detailed
  rationale was supplied, so this is limited advisory evidence, not a test substitute.

The fallback mismatch is pre-existing and unrelated to prompt routing; no model
routes were changed. Unit tests check injection and safety boundaries, not how
often a model will choose subagents. No behavioral A/B benchmark was performed.

## Pi API references

- [Extension hooks and structured prompts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Prompt customizer example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/prompt-customizer.ts)
- [Skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)

Documentation was checked with Context7 library `/earendil-works/pi` and the
installed Pi declarations/examples.
