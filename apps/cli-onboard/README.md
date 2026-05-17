# @octopus/cli-onboard

First-run interactive setup wizard for the Octopus CLI. Built with [ink](https://github.com/vadimdemedes/ink) (React for terminals).

## What it does

Walks a new user from "I just installed `octp`" to "my next `git push` triggers an AI review using the model I picked":

1. **Welcome** — what Octopus is, in three sentences
2. **Auth** — sign in to the hosted Octopus account *or* point at a self-hosted instance
3. **Org** — pick the organisation context (hosted only)
4. **Provider** — pick which AI provider runs the review (Claude / OpenAI / Google / Cohere; with Workstream 5 also Grok / ACPX / OpenCode / Ollama)
5. **Model** — pick a model from the chosen provider
6. **BYOK** — enter the API key (or skip and use the org's platform key)
7. **Validate** — live API ping to confirm the key works
8. **Repo install** — pick a GitHub repo and install the Octopus App (hosted only)
9. **Done** — summary of what was configured + next steps

Each step is small, has phase-state (`running | done | failed | skipped`), and follows the same footer convention: `Enter to continue · Esc to skip · Left to go back`.

## Persistence

State lives under `$OCTOPUS_HOME` (default `~/.octopus/`) in three files, all mode `0600` in a mode `0700` directory:

| File | Purpose | Safe to cat? |
|---|---|---|
| `config.json` | Versioned prefs (chosen provider/model, defaults). Presence of `onboardedAt` gates first-run. | Yes |
| `byok.json` | Provider API keys, separated from prefs. | No |
| `credentials` | Auth tokens for the hosted Octopus account. | No |

A corrupt or unreadable `config.json` is treated as missing — the wizard re-runs instead of crashing.

## Opt-outs

- `OCTOPUS_NO_ONBOARD=1` — permanent skip (env var)
- `--skip-onboard` — one-shot skip (CLI flag)
- `--reset-onboard` — re-runs the wizard, pre-seeding existing config

## How `@octp/cli` embeds this

`@octp/cli` imports `ensureOnboardCompleted()` from `@octopus/cli-onboard` on every launch. If `config.json#onboardedAt` is missing, the wizard runs; otherwise it's a fast no-op (~1ms).

This package is built standalone so it can also be invoked directly: `bunx @octopus/cli-onboard` or, after install, `octp-onboard`.

## Status

Phase 1 (this commit): package skeleton, Welcome → Done flow, config persistence, opt-outs. Real steps land in follow-up PRs tracked under [Workstream 7](../../README.md#roadmap).
