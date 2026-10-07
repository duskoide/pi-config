# Pi configuration ports for Pig

This port targets **Pig 0.3.1** and the extension versions recorded in
[`ports.json`](ports.json). Pig is Go, but it officially supports Pi-compatible
Node/TypeScript extension factories in subprocesses. Using that supported API
preserves the original tools, UI components, schemas, and provider transports
without an unnecessary Go rewrite. Node is still a runtime dependency.

## Install

From the repository root, with `pig` and Node on PATH:

```sh
node scripts/install-pig.mjs --from-pi-cache
```

This checks the installed versions in Pi's npm cache, copies **only the selected
dependency closure**, applies audited adapters to that private copy, validates
all exact entrypoints with Pig, and then enables the bundle in Pig's settings.
Pi's extensions, settings, credentials, and sessions are not modified.
`--from-pi-cache` fails if the cache is missing; it never invokes npm or falls
back to a download.

To download source dependencies instead of using Pi's cache:

```sh
node scripts/install-pig.mjs --download
```

To materialize a bundle without validation or activation:

```sh
PIG_HOME=/tmp/pig-port-preview node scripts/install-pig.mjs --prepare-only
```

Each prepared-only bundle uses a unique `pig-pi-config-preview-<uuid>`
destination and never replaces the active registered bundle. It is **not**
evidence that extensions load successfully.
Normal installation must pass registration validation before activation.
`PIG_USE_PI_DIRS=1` is rejected: this installation deliberately keeps the two
agents' files separate.

Paths respect `PIG_HOME`, `XDG_CONFIG_HOME`, and `PIG_CODING_AGENT_DIR`.
`PIG_BINARY` selects an exact binary. The default destination is
`~/.pig/agent/pig-pi-config`; Pig's existing default model/provider and unrelated
settings are retained. Existing bundle/settings files receive timestamped
backups. Mutable configuration is copied, not linked into Pi's checkout.

No auth file is read or copied by the installer. A literal key in the portable
custom-provider file is replaced with a `$PROVIDER_NAME_API_KEY` reference.
Model fetching is disabled in that migrated file until you explicitly run
`/custom-provider refresh`. Supply Pig credentials with Pig's `/login`, not by
sharing Pi's auth directory. Existing Pig configuration files are not replaced.

## Extension inventory

| Pi package/resource | Pig realization |
|---|---|
| image-paste 2.5.1 | Original clipboard/UI factory through Pig's Node runtime |
| pi-antigravity 0.7.2 | Original provider/image tool; `.pig/generated-images` output |
| pi-fff 0.10.6 | Original native FFF-backed search and UI; Pig-specific data paths |
| context7-pi 0.1.2 | Original resolve/query tools and skill |
| pi-undo-redo 0.1.1 | Original file snapshots and undo/redo commands |
| pi-herdr-sudo-task 0.1.5 | Original reviewed sudo workflow; still requires Herdr and terminal consent |
| pi-usage-bars 0.6.0 | Original provider usage widgets |
| rpiv-ask-user-question 2.9.0 | Original structured dialog and preview UI |
| rpiv-todo 2.9.0 | Original branch-aware task state and UI |
| rpiv-web-tools 2.9.0 | Original search-provider selection/fetch tools |
| rpiv-advisor 2.9.0 | Original advisor UI/model calls |
| rpiv-btw 2.9.0 | Original side-question workflow |
| pi-commandcode-provider 0.6.4 | Original provider; Pig credential lookup |
| pi-powerline-footer 0.17.0 | Original footer; Pig settings/resource paths; resolved-keybindings API adapted for the editor |
| pi-background-tasks 2.5.0 | Selected background-tasks factory, not ambient attribution; Pig child launches and `.pig` artifacts |
| pix-pretty 1.22.0 | **Inert in the original package selection:** no declared/conventional extension members; not implicitly activated |
| pi-provider-qoder 0.4.7 | Original provider; Pig auth/model-cache/machine-ID paths |
| pi-agent-teleport 0.2.4 | Original managed worktrees/history; Pig continuation executable; moves require Herdr |
| pi-subagent 25.0.2 | **Adapted:** local bounded read-only Pig workers instead of Herdr agent transport |
| pi-task-models 7.0.5 | Original task-model configuration extension |
| pi-gpt-enhance 0.3.0 | Original GPT enhancement; Pig configuration/caches |
| custom-providers.ts | Local original provider management factory |
| pdf-to-markdown.ts | Local original converter; separate `pig-pdf2md` cache; engine installation only on explicit conversion |
| tool-routing.ts | Local original tool-conditioned prompt guidance |

`port-report.json` in the installed bundle records exact selected members,
dependency versions/paths, source transformations, and SHA-256 file digests.
Third-party licenses remain next to their original source. The bundle is private;
nothing is published or pushed.

## Important differences and limits

This is not a claim of full Pi/Pig behavioral parity:

* **Herdr agent kinds:** the installed Herdr accepts `pi` but not `pig`. The
  upstream checked isolated subagent graph cannot be activated honestly against
  that backend. `delegate_task` rejects isolated/writing requests without any
  fallback. The original `subagent_stage`, `subagent_integrate`, recovery and
  promotion surface is not exposed by the local adapter.
* **Local direct delegation:** roles are `scout`, `reviewer`, and `researcher`.
  Workers use Pig's built-in `read,grep,find,ls`; project approval, context files,
  ambient extensions, skills, and recursive delegation are disabled. Selected
  inference-provider entrypoints may be passed explicitly. This is a tool-level
  policy, **not an OS sandbox**. Single packets, parallel packets (concurrency 3),
  and chains with `{previous}` work. A shared limiter caps productive children
  at three across all workflows. Shutdown cancels and drains child process
  groups. Each child has an idle/hard-time limit and turn/token/output bounds.
  With an interactive UI the tool returns a handle and one follow-up. In
  headless mode it waits for results inside the tool call, so print mode cannot
  exit before delivering them. Results are suppressed after an owning branch
  is abandoned. `/subagent` inspects local tasks, `/subagent show <id>` displays
  retained results, and `/subagent cancel <id>` cancels one. The bundled skill
  describes this adapter, not the unavailable upstream checked graph runner.
  Local handles are session-scoped, not durable Herdr recovery identities.
* **Class routes:** explicit `modelClass` resolves through Pig's `/task-models`
  profiles, checking model availability and supported thinking levels. Missing
  routes are errors, never silently aliases for the current model. An optional
  native-adapter override in `~/.pig/agent/pig-port.json` takes precedence:
  `{"taskProfiles":{"fast":{"model":"openai-codex/gpt-5.5","thinking":"low"}}}`
  selects that exact route (use a model available in your Pig installation).
  This user-owned file survives reinstalling the generated bundle. Without a
  model/class override the worker uses the current Pig model and thinking level.
  Explicit model overrides retain the class profile's thinking level.
* **Pi attestation:** `bg_run_pi_attested` is not exposed. Merely substituting
  Pig into a producer promising Pi/OAuth/channel evidence would be misleading.
  Ordinary background/delegate/Fusion tools remain selected for registration.
* **Teleport:** Pig's D61 retains startup-project services across session
  replacement. A no-Herdr move is refused rather than claiming to change the
  active working directory. Create/history/remove remain available; Herdr
  continuation commands launch `pig`. Destination startup still needs a
  compatible Pig configuration and credentials.
* **Generated Herdr integration:** Pi's generated agent-state extension is not
  copied or renamed to masquerade as a Pig agent. Native Pig support needs an
  integration from Herdr itself.
* **Provider/UI verification:** registration alone does not prove live OAuth,
  provider availability, clipboard behavior, custom terminal rendering, or
  platform-specific privileged execution. Those need the corresponding user
  account, terminal, and external service. No privileged command is run during
  installation or testing.

## Check

```sh
node --test tests/pig-port.test.mjs
npm test
node scripts/check-pig-ports.mjs
node scripts/check-pig-editor.mjs
# Check the activated bundle, still using disposable test data:
node scripts/check-pig-editor.mjs --installed
```

The smoke test uses an ephemeral HOME/config/workspace and a loopback model
fixture; it must not use your auth files or public model services. It checks
runtime tool/command declarations, exercises selected tools through Pig's real
agent loop, verifies that web fetch rejects private/loopback addresses, and
launches real read-only Pig children through both `delegate_task` and the child
process adapter. UI-only and privileged
tools must remain hidden in headless/non-Herdr mode. Failures retain a diagnostic
JSON file in the system temporary directory.

The editor smoke uses Python's standard-library PTY support and a separate
HOME/config/workspace. It loads the bundle's Powerline factory in an interactive
Pig (without the startup welcome overlay), proves input reaches `BashModeEditor`,
types characters, moves the cursor, and presses backspace, then checks the
resulting draft. It never submits a prompt or invokes a model. This exercises
Powerline's custom editor and keybindings manager, which headless registration
and tool-loop checks cannot cover. The private editor port uses
`getResolvedBindings()` (the implementation behind Pi's app-manager
`getEffectiveConfig()`) so host user overrides and disabled actions are retained.

After editing an adapter, rerun the installer. Do not edit generated vendor
sources: rebuilding replaces them. Update `ports.json` deliberately when an
extension version changes; required transformation anchors fail closed on
source drift instead of guessing.
