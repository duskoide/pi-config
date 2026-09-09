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
- links `.pi/web-search.json` and `herdr/config.toml` into their standard locations
- installs each pinned npm/Git Pi package listed in `.pi/agent/settings.json`
- installs the local package containing this repository's custom extensions and skills
- registers Herdr's generated Pi integration without copying that generated file into Git

Existing destination files are moved to timestamped `.pre-config.*` backups before
links are created. The installer never manages `auth.json`, sessions, caches,
model catalogs, logs, or runtime state.

To test only the filesystem/linking and validation logic without network installs:

```bash
tmp_home="$(mktemp -d)"
HOME="$tmp_home" \
PI_CODING_AGENT_DIR="$tmp_home/.pi/agent" \
PI_HOME_DIR="$tmp_home/.pi" \
PI_CONFIG_SKIP_EXTERNAL_INSTALLS=1 \
./install.sh
rm -rf "$tmp_home"
```

The normal checkout path is `~/pi-config`; the relative local-package entry in
the global settings file assumes that layout.

## What is portable

- `.pi/agent/settings.json`: Pi defaults, enabled models, subagent routing, and
  exact npm/Git package selections
- `.pi/agent/keybindings.json` and `.pi/agent/custom-providers.json`
- user agent definitions under `.pi/agent/agents/`
- project agent definitions under `.pi/agents/`
- `.pi/agent/pi-searxng-suite.json` and `.pi/agent/provider-failover.json`
- custom extensions in `extensions/`
- custom skills in `skills/`
- `herdr/config.toml`

The `archive/legacy/` directory is retained for rollback/reference only. Nothing
there is loaded by the package manifest.

## Credentials and machine data

Credentials are deliberately excluded. Start Pi and use:

```text
/login
```

Keep `~/.pi/agent/auth.json` private. API-key settings should use environment
variables; do not put literal secrets in this repo.

The repository also excludes sessions, memory, caches, model catalogs, package
install trees, logs, missions, subagent artifacts, generated Herdr integration
files, and other runtime state.

## Updating

For Pi settings or custom resources, edit the checked-in files and rerun
`./install.sh`; restart Pi or use `/reload` where appropriate.

To update a third-party package, change its exact `npm:...@version` or pinned Git
commit in `.pi/agent/settings.json`, then run `./install.sh`. To update Pi itself,
set `PI_VERSION` explicitly or change the default in `install.sh`.

For Herdr configuration changes, edit `herdr/config.toml` and run:

```bash
herdr server reload-config
```

Review extensions, skills, and third-party packages before enabling them: they
execute with the permissions of the current user.
