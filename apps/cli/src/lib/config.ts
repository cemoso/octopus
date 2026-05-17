import { readFile, writeFile } from "node:fs/promises";
import { ensureOctopusHome, getConfigPath } from "./paths.js";

/**
 * Bumped when the on-disk shape changes. An older or unparseable file is
 * treated as missing — the wizard re-runs instead of crashing on a stale file.
 */
export const CONFIG_VERSION = 1;

export type OctopusConfig = {
  version: number;
  /** ISO timestamp of when the user completed the wizard. Presence gates first-run. */
  onboardedAt?: string;
  /** Provider slug chosen during onboarding ("anthropic" | "openai" | "google" | …). */
  provider?: string;
  /** Model ID chosen during onboarding (e.g. "claude-sonnet-4-6", "gpt-4o"). */
  model?: string;
  /** Hosted API base URL when self-hosting. Absent when using the SaaS. */
  selfHostedBaseUrl?: string;
};

const EMPTY: OctopusConfig = { version: CONFIG_VERSION };

/**
 * Load the config. Returns an empty (un-onboarded) config when the file is
 * missing, unreadable, unparseable, or has a different version — never throws
 * for filesystem or schema reasons. The wizard treats all of these as "needs
 * to re-run".
 */
export async function loadConfig(): Promise<OctopusConfig> {
  try {
    const raw = await readFile(getConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      (parsed as OctopusConfig).version === CONFIG_VERSION
    ) {
      return parsed as OctopusConfig;
    }
    return { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * Persist the config with restrictive permissions. Creates the home dir if it
 * doesn't exist. Stamps `onboardedAt` if not already set.
 */
export async function saveConfig(next: OctopusConfig): Promise<void> {
  await ensureOctopusHome();
  const out: OctopusConfig = {
    ...next,
    version: CONFIG_VERSION,
    onboardedAt: next.onboardedAt ?? new Date().toISOString(),
  };
  await writeFile(getConfigPath(), JSON.stringify(out, null, 2), { mode: 0o600 });
}

export function isOnboarded(c: OctopusConfig): boolean {
  return Boolean(c.onboardedAt);
}
