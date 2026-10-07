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
- `.pi/agent/pi-searxng-suite.json`
- custom extensions in `extensions/`
- custom skills in `skills/`
- `herdr/config.toml`

The `archive/` directories (`legacy/`, `removed-delegators/`, `removed-failover/`) are
retained for rollback/reference only. Nothing there is loaded by the package manifest.

## Retained role definitions

Scout, Researcher, Worker, and Reviewer profiles remain in `.pi/agents/` and
are linked into `~/.pi/agents/` for possible future compatible runners. These
legacy files record model and tool preferences but do not activate runnable
agents or grant tool permissions on their own.

## Delegation

Delegation is provided by two packages; the old `pi-delegator` setup (`delegate`,
`delegate_start/result/cancel`, `/delegator-config`) was removed and is kept under
`archive/removed-delegators/` for reference.

- `pi-optchat` (unpinned): persistent per-profile chat with `spawn`/`tell` subagents,
  a summarizing compactor and `zoom`/`date` memory tools. Models for the compactor and
  subagents are chosen with `/optchat model`; state lives in `~/.optchat/`, not in this repo.
- `pi-background-tasks@2.5.0` (filtered to `extensions/background-tasks.ts`): `bg_run`,
  `bg_delegate` (read-only), and Fusion workflows.

## Health checks and routing

Run the static, offline check after editing configuration:

```bash
npm run check:config
```

It validates the default route, package pins, retained role files and trust/network
bounds without printing credentials. Pin drift, a
`defaultProjectTrust` of `"always"`, and a disabled HTTP idle timeout are
reported as warnings rather than failures, so deliberate local choices stay
visible without masking real errors. For an explicit
live smoke of the configured default (one provider request), run:

```bash
npm run check:config:live
```

The live probe uses a disposable working directory, requires the installed
agent's settings file to byte-match this checkout, passes `--no-tools`,
and requires the final JSON event to report the exact configured provider and
model. It still uses machine-local Pi credentials/catalogs; it does not prove
that credentials are present without making the request.

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
