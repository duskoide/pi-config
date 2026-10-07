# Portable Pi + Herdr configuration

This repository is a clean baseline for the current Pi setup. It keeps portable
configuration, custom Pi resources, and exact third-party package selections in
Git while leaving credentials and machine runtime data local.

## Install

Requirements: Node.js, npm, curl, and Git.

```bash
git clone https://github.com/duskoide/pi-config.git ~/pi-config
cd ~/pi-config
./install.sh
pi
```

The installer:

- installs the Pi `latest` dist-tag by default (`PI_VERSION=0.99.1` pins an exact release)
- installs Herdr from its official installer when it is not already available
- links the allowlisted files under `.pi/agent/` into `~/.pi/agent`
- links retained role definitions from `.pi/agents/` into `~/.pi/agents/`
- links `.pi/web-search.json` and `herdr/config.toml` into their standard locations
- installs each pinned npm/Git Pi package listed in `.pi/agent/settings.json`
- loads the local package containing this repository's custom extensions and skills
- registers Herdr's generated Pi integration without copying that generated file into Git
- runs the dependency-free static configuration health check before reporting readiness

Existing destination files are moved to timestamped `.pre-config.*` backups before
links are created. The installer never manages `auth.json`, sessions, caches,
model catalogs, logs, or runtime state.

To test only the filesystem/linking and validation logic without network installs:

```bash
tmp_home="$(mktemp -d)"
HOME="$tmp_home" \
PI_CODING_AGENT_DIR="$tmp_home/.pi/agent" \
PI_HOME_DIR="$tmp_home/.pi" \
HERDR_CONFIG_DIR="$tmp_home/.config/herdr" \
PI_CONFIG_SKIP_EXTERNAL_INSTALLS=1 \
./install.sh
rm -rf "$tmp_home"
```

The installer creates a `pi-config` symlink beside the global settings file,
so the checkout can live anywhere. Direct package versions are pinned here, and
`pi-background-tasks` is filtered to its background-task extension so this setup
uses the normal Anthropic API-key transport rather than subscription attribution.
Each package's transitive dependency lock remains in Pi's local package cache.
npm may report pending native install scripts; this installer does not
auto-approve them.

## What is portable

- `.pi/agent/settings.json`: Pi defaults, enabled models, and exact npm/Git package selections
- `.pi/agent/keybindings.json` and `.pi/agent/custom-providers.json`
- legacy user agent definitions under `.pi/agent/agents/` (preserved for compatibility)
- retained role definitions under `.pi/agents/`, linked globally to `~/.pi/agents/`
- `.pi/agent/pi-searxng-suite.json` and `.pi/agent/provider-failover.json`
- `.pi/agent/pi-delegator.json` and its role prompts under `.pi/agent/delegator/`
- custom extensions in `extensions/`
- custom skills in `skills/`
- `herdr/config.toml`

The `archive/legacy/` directory is retained for rollback/reference only. Nothing
there is loaded by the package manifest.

## Retained role definitions

Scout, Researcher, Worker, and Reviewer profiles remain in `.pi/agents/` and
are linked into `~/.pi/agents/` for possible future compatible runners. These
legacy files record model and tool preferences but do not activate runnable
agents or grant tool permissions on their own. The existing `subagents`
settings block is retained but is not read by pi-delegator. Neither these files
nor that settings block controls the `delegate` tool below.

## Delegation

`@mostlyworks/pi-delegator` is pinned to `0.6.6` and provides the `delegate` tool.
Its managed configuration is `.pi/agent/pi-delegator.json`; the installer links
it and the `delegator/` prompt directory into `~/.pi/agent/`.

The five standard profiles retain the upstream prompts and tool access. The
thinking column below describes the upstream baseline, not a restriction on
interactive customization:

| Profile | Thinking | Tools |
| --- | --- | --- |
| `scout` | `low` | read, grep, find, ls |
| `reviewer` | `high` | read, grep, find, ls, bash |
| `oracle` | `high` | read, grep, find, ls |
| `tester` | `high` | read, grep, find, ls, bash |
| `worker` | `high` | read, grep, find, ls, bash, edit, write |

The starter setup used `model: null` (inherit the active parent model).
Current model/thinking choices are stored in `.pi/agent/pi-delegator.json` and
may be customized through the command below. Profiles retain `deadlineMs: null`
(no overall timer) and empty skills. Explicit child adapters load Qoder and
optional per-profile initial failover; ambient extensions/skills are not inherited. Reviewer/tester no-edit restrictions are prompt
instructions, not enforced write protection through Bash.

Use `/delegator-config` (or `/delegator-config oracle`) to interactively choose
an agent type and choose primary model/thinking or initial fallback settings.
Primary edits preserve profile capabilities; fallback edits touch only the
`delegator/failover.json` sidecar. All fallbacks default to disabled: use
`/delegator-config oracle fallback` to choose one. A switch is allowed once,
before any output or tool use, for foreground and background agents alike.
Repository symlinks and the parent's model/thinking remain unchanged. Trusted
project primary overrides are edited in their own file. Run `/reload` once to discover
this command in an already-running session; **restart Pi after saving** to apply
the delegate settings.

After changing profiles, run `npm run check:delegator`, rerun `./install.sh`
when installing on another machine, and **restart Pi**. The full
`npm run check:config` includes these checks too. See
[the configuration guide](docs/pi-delegator.md) for overrides and limitations.
The vendored prompts retain their upstream MIT license in `delegator/LICENSE`.

### Background agents

The local extension adds `delegate_start`, `delegate_result`, and `delegate_cancel`
without changing foreground `delegate`. Start several independent profiles and
let the main session keep working; default hidden completion notifications wake
a follow-up turn. Progress appears in a single width-aware `Agents` statusline
below the editor (e.g. `scout:read · reviewer:bash · worker:done`), not repeated
chat blocks. Its reserved row is independent of Powerline's segment packing.
Launch/cancel rows stay hidden while collapsed; result retrieval is a single
compact row with full details available through tool expansion. For example,
ask Pi to use background scout and reviewer agents.

`delegate_result` without a task ID lists this session's jobs; with an ID it
returns the answer or a nonblocking not-ready status. Do not poll while default
notifications are pending. Use disjoint files or separate worktrees for workers
and parent edits. Jobs are not sandboxed and no worktrees are created automatically.

Jobs and unread results are memory-only and session-scoped. Reload, new/resumed
sessions, forks, teleport teardown, and orderly quit cancel jobs and await the
pinned runner's process cleanup; restart does not resume them. At most eight run
at once and 32 job entries are retained (unread results are never silently evicted).
Child usage reaches parent totals on the first terminal result retrieval. See
[the background guide](docs/pi-delegator.md#background-delegation) for schemas,
limits, cancellation semantics, and safety caveats.

## Health checks and routing

Run the static, offline check after editing configuration:

```bash
npm run check:config
```

It validates the default route, package pins, retained role files, trust/network bounds,
and failover configuration without printing credentials. Pin drift, a
`defaultProjectTrust` of `"always"`, and a disabled HTTP idle timeout are
reported as warnings rather than failures, so deliberate local choices stay
visible without masking real errors. For an explicit
live smoke of the configured default (one provider request), run:

```bash
npm run check:config:live
```

The live probe uses a disposable working directory, requires the installed
agent's settings/failover files to byte-match this checkout, passes `--no-tools`,
and requires the final JSON event to report the exact configured provider and
model. It still uses machine-local Pi credentials/catalogs; it does not prove
that credentials are present without making the request.

For the failover consumer itself, run the isolated local-server smoke:

```bash
npm run check:failover
```

It uses fake credentials, an empty explicit `fallbacks` list, two local
OpenAI-compatible endpoints, a fresh HOME/agent directory, and bounded process
cleanup. Its fixture temporarily enables broad discovery only so generic local
providers can exercise the consumer; production config disables that option.
It proves extension loading, sanitized status reporting, and synthetic
primary-failure → fallback-success only; it does not prove production provider
availability or account rotation.

`pi-multi-account` owns runtime account rotation and failover. The tracked
`provider-failover.json` deliberately does **not** rank `openai-codex` as a
failover destination: that family's ranking auto-selects its flagship model
(`openai-codex/gpt-5.6-sol`). `providerPriority` is the ordered ladder that
decides cross-provider selection — unlisted providers sort after everything
listed — so it reads `deepseek -> tokenharbor` and the explicit `fallbacks` list
names `tokenharbor/deepseek-v4-flash`, then `commandcode/Qwen/Qwen3.8-27B`.

`providerOrder` is **not** an exclusion mechanism: `normalizeConfig()` treats it
as a sequence preference and re-appends every unlisted managed family, so
`openai-codex` and `anthropic` remain in it regardless. It therefore lists only
`openai-codex`, the sole managed family this machine actually has credentials
for; `anthropic` has no credential, so it is left unranked in both ladders where
possible and is never a preferred target.

`includeOtherProviders` stays `false`: providerPriority is ordering, not an
allowlist, so broad API-key discovery remains disabled even though two routes are
named explicitly. Explicit targets still resolve, because `resolveTargets()`
looks up a named provider+model through `findModelIncludingHidden()` rather than
through the discovery gate. It also keeps `autoDiscoverModels`, `childProxy`, and
`debugLog` off by default, avoiding the configured live-catalog discovery path,
loopback auth shadowing, and persistent failover logs. Other
registration/publication paths may still exist in the extension. It also caps
automatic continuations at eight per prompt: pi-multi-account `1.22.0` retries
transient `5xx`/overload errors against the same provider and model with
session-local backoff instead of escalating them into the failover ladder, so a
higher cap no longer multiplies cross-provider switches. The current Command
Code default is outside managed account discovery, so production recovery from
that route is
still unverified. Installing it enables code that reads `auth.json` and may
update failover state; it fingerprints credentials rather than logging raw keys.

## Credentials and machine data

Credentials are deliberately excluded. Start Pi and use:

```text
/login
```

Keep `~/.pi/agent/auth.json` private. The tracked `custom-providers.json`
may contain provider URLs and `$ENV_VAR` references, but never put literal API
keys or tokens in this repository. This configuration uses normal Anthropic
API-key transport; the subscription-only attribution extension is intentionally
excluded from the `pi-background-tasks` package filter. Restore that extension
only when Pi OAuth/account attribution is configured and desired. This applies
to ordinary ambient Pi loading; Fusion, delegate, and attested Anthropic child
paths may explicitly load the attribution extension and remain OAuth-only.

The repository also excludes sessions, memory, caches, model catalogs, package
install trees, logs, missions, subagent artifacts, generated Herdr integration
files, and other runtime state.

## Updating

For Pi settings or custom resources, edit the checked-in files, run
`npm run check:config`, and rerun `./install.sh`; restart Pi or use `/reload`
where appropriate. This machine intentionally sets `defaultProjectTrust` to
`"always"` and `httpIdleTimeoutMs` to `0` (idle timeout disabled); both are
reported as warnings by the health check rather than failures, and both widen
trust relative to Pi's defaults.

To update a third-party package, change its exact `npm:...@version` or pinned Git
commit in `.pi/agent/settings.json`, then run `./install.sh`. Pi itself follows the
`latest` dist-tag on every `./install.sh` run; set `PI_VERSION` to an exact release to
pin it, or use `pi update --all` to refresh Pi and its packages without reinstalling
the rest of this configuration.

For Herdr configuration changes, edit `herdr/config.toml` and run:

```bash
herdr server reload-config
```

Review extensions, skills, and third-party packages before enabling them: they
execute with the permissions of the current user.
