# AGENTS.md — apps/cli-onboard

Scoped rules for this package. The root [AGENTS.md](../../AGENTS.md) still applies.

## Stack constraints

- Built with **ink ^6** (React for terminals). Do **not** introduce a second TUI library.
- No Next.js, no Prisma, no database access. This package runs on the user's laptop with zero infrastructure.
- All persistence is to files under `$OCTOPUS_HOME` (default `~/.octopus/`). No HTTP calls unless explicitly necessary for the step (e.g. validation pings, OAuth).
- Secrets stay in `byok.json` / `credentials` — never in `config.json` (the prefs file must remain safe to `cat`).

## Step component conventions

- Each step is a self-contained component in `src/steps/`.
- Props: `{ onNext: (patch?) => void; onBack?: () => void }`. The wizard owns the answer accumulator; the step calls `onNext` with the fields it collected.
- Steps that do work (auth, validation, save) hold an internal `phase` state of `running | done | failed | skipped`. On `failed`, surface the error inline and offer `Enter to retry / Esc to skip`.
- Footer hint convention: `Press Enter to continue · Esc to skip · Left to go back`. Keep it on the last line of every step.

## Don't

- Don't render to `process.stdout` directly. Pipe subprocess output into React state, then render it.
- Don't `process.exit()` from a step. Call `useApp().exit()` so ink can clean up the terminal.
- Don't add `chalk` / `kleur` / other color libraries — use ink's `<Text color>` prop.

## Testing

- `bun test` with `bun:test`. Use a per-test `OCTOPUS_HOME = mkdtemp()` and clean up in `afterEach`.
- Step components don't need full ink render tests yet (testing ink is awkward); cover the `lib/` utilities thoroughly instead and integration-test the wizard end-to-end in a follow-up.
