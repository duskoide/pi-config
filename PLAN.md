# Plan: Add a "Fortune Cookie" pi Extension 🥠

A tiny pi extension that serves a random fortune cookie message at the start of every session.

## Goals

- Bring a moment of whimsy to terminal coding sessions
- Demonstrate minimal pi extension structure (hooks + a `/fortune` command)
- Zero runtime dependencies

## Steps

- [ ] Create `extensions/fortune/index.ts` registering a `session_start` hook
- [ ] Add a `fortunes.json` file with ~50 hand-written fortunes (coding-themed)
- [ ] Register a `/fortune` slash command for on-demand cookie cracking
- [ ] Render fortunes in a themed box with cookie ASCII art
- [ ] Add optional `--lucky-numbers` flag that appends 6 random numbers
- [ ] Write a test that asserts fortunes are picked uniformly over 1000 draws
- [ ] Document usage in `README.md` with a screenshot of the cookie art

## Non-goals

- No network calls (fortunes are local only)
- No persistence of cracked cookies

## Risks

- Fortune repetition may get stale → mitigate with weighted shuffle
- ASCII art may break on narrow terminals → wrap/clamp at 40 cols

## Acceptance criteria

- Starting pi shows exactly one fortune, no extra latency (>50ms)
- `/fortune` works mid-session and never repeats the previous fortune
