#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { OnboardWizard } from "./OnboardWizard.js";
import { isOnboarded, loadConfig } from "./lib/config.js";

/**
 * Entry: TTY gate + opt-out parsing + first-run check + render.
 *
 * Exits 0 without rendering when:
 *   - stdin is not a TTY (piped or non-interactive shell)
 *   - OCTOPUS_NO_ONBOARD=1 is set
 *   - --skip-onboard is passed
 *   - the user has already onboarded (unless --reset is passed)
 */
export async function ensureOnboardCompleted(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--skip-onboard")) return;
  if (process.env.OCTOPUS_NO_ONBOARD === "1") return;
  if (!process.stdin.isTTY) return;

  const reset = argv.includes("--reset") || argv.includes("--reset-onboard");
  const config = await loadConfig();
  if (isOnboarded(config) && !reset) return;

  await new Promise<void>((resolve) => {
    const { waitUntilExit } = render(<OnboardWizard />);
    waitUntilExit().then(() => resolve());
  });
}

/**
 * Forced re-run, used by the CLI's `octp onboard` subcommand. Skips the
 * opt-out checks since the user explicitly asked for it.
 */
export async function launchOnboardWizard(): Promise<void> {
  await new Promise<void>((resolve) => {
    const { waitUntilExit } = render(<OnboardWizard />);
    waitUntilExit().then(() => resolve());
  });
}

// When invoked directly (octp-onboard binary), run the gated flow.
const isDirectInvocation =
  typeof process !== "undefined" && process.argv[1]?.endsWith("cli-onboard/dist/index.js");
if (isDirectInvocation) {
  ensureOnboardCompleted().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
