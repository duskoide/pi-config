# Portable Pi configuration

This directory is the source of truth for my Pi setup. It keeps Pi's static configuration and custom resources in Git while leaving credentials and machine runtime data local.

## New machine

Requirements: Node.js, npm, and Git.

```bash
git clone https://github.com/duskoide/pi-config.git ~/pi-config
cd ~/pi-config
./install.sh
pi
```

The installer pins Pi to `0.84.1`, links the checked-in static files into `~/.pi/agent`, installs the local Herdr worker package dependency from its lockfile, and validates the JSON configuration.

It is safe to run repeatedly. Existing files are moved to a timestamped `.pre-pi-config.*` backup before a link is created. The installer never links or copies `auth.json`, sessions, caches, model catalogs, state, or logs.

If the machine uses a non-default Pi config directory, set `PI_CODING_AGENT_DIR` before running the installer:

```bash
PI_CODING_AGENT_DIR="$HOME/.config/pi" ./install.sh
```

## Credentials

Credentials are deliberately not part of this repository. On each machine, start Pi and use:

```text
/login
```

Then authenticate each provider you need. API-key providers can also use their documented environment variables. Keep `~/.pi/agent/auth.json` private (`0600`) and never commit it.

The credential file on the source machine contained live-looking API/OAuth tokens and was not copied here. Rotate or revoke those tokens if they were exposed outside the intended machine/session.

## What is portable

- `settings.json`, append-system instructions, and agent definitions
- custom extensions, including the Macaron provider and PDF-to-Markdown tool
- checked-in skills (`find-skills` and the Herdr operating instructions)
- provider/package settings that do not contain tokens
- exact package versions in `settings.json` and `pi-herdr-worker/package-lock.json`

Installed npm Pi packages are referenced by exact version in settings and are fetched into Pi's local package cache on the new machine. Their source code remains outside this repository.

## What stays local

- `auth.json` and OAuth refresh/access tokens
- sessions, daily memory, caches, model catalogs, failover state, logs, and generated stores
- `node_modules` and Python virtual environments
- project trust decisions, which are machine-specific

The repo's `.gitignore` protects these categories. Pi itself may still create them under `~/.pi/agent` during normal operation.

## Updating the setup

When changing Pi resources, edit the checked-in files under `.pi/agent`, then run `./install.sh` and restart Pi (or use `/reload`). When adding a third-party package, pin its version in `.pi/agent/settings.json` and update the installed package on the source machine before testing.

Review extensions and skills before enabling them: Pi packages and extensions execute with the permissions of the current user.
