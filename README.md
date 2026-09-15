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

- installs Pi `0.85.1` by default (`PI_VERSION=latest` opts into the latest stable release)
- installs Herdr from its official installer when it is not already available
- links the allowlisted files under `.pi/agent/` into `~/.pi/agent`
- links portable subagent definitions from `.pi/agents/` into `~/.pi/agents/`
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

- `.pi/agent/settings.json`: Pi defaults, enabled models, subagent routing, and
  exact npm/Git package selections
- `.pi/agent/keybindings.json` and `.pi/agent/custom-providers.json`
- legacy user agent definitions under `.pi/agent/agents/` (preserved for compatibility)
- active `pi-core-subagent` definitions under `.pi/agents/`, linked globally to `~/.pi/agents/`
- `.pi/agent/pi-searxng-suite.json` and `.pi/agent/provider-failover.json`
- custom extensions in `extensions/` and the pinned `pi-core-subagent` fork in `vendor/`
- custom skills in `skills/`
- `herdr/config.toml`

The `archive/legacy/` directory is retained for rollback/reference only. Nothing
there is loaded by the package manifest.

## Subagents

The portable Scout, Researcher, Worker, and Reviewer definitions live in
`.pi/agents/`. The active subagent extension first matches an exact
case-insensitive filename stem (for example, `researcher` → `Researcher.md`),
then falls back to description matching for free-form agent names. Inspect a
task's reported `agentFile` when testing a new task.

The vendored `pi-core-subagent` fork keeps child extension discovery disabled
but permits Researcher to request the existing `web_search` and `web_fetch`
definitions from `@juicesharp/rpiv-web-tools`. No web tools are added to other
children by default. Run `/web-tools` once on each machine to configure a search
provider; `web_fetch` itself does not require a search API key.

Named roles use the model in their exact role file as the source of truth. Scout,
Worker, and Reviewer use the proven Codex route; Researcher uses the proven
Command Code route and is the only role with web tools. Thinking level is set
when dispatching: Scout typically uses `low` or `medium`; Researcher, Worker,
and Reviewer use `high` (or `max` for unusually difficult reviews). Worker must
be dispatched with `write: true` to receive editing tools and worktree isolation.
Reviewer is read-only and must be pointed at a checkout containing the change or
be given its diff and changed-file list.

## Health checks and routing

Run the static, offline check after editing configuration:

```bash
npm run check:config
```

It validates the default route, package pins, role files, trust/network bounds,
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
automatic continuations at two per prompt. The current Command Code default is
outside managed account discovery, so production recovery from that route is
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
commit in `.pi/agent/settings.json`, then run `./install.sh`. To update Pi itself,
set `PI_VERSION` explicitly or change the default in `install.sh`.

For Herdr configuration changes, edit `herdr/config.toml` and run:

```bash
herdr server reload-config
```

Review extensions, skills, and third-party packages before enabling them: they
execute with the permissions of the current user.
