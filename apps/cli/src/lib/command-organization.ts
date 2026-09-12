import { flagValue } from "./args.js";
import { loadStoredCredentials, setCommandCredentials } from "./credentials.js";
import { resolveOrganization } from "./organizations.js";
import { detectOnboardingRepository } from "./git-repository.js";
import { sanitizeTerminal } from "./output.js";

export const ORGANIZATION_COMMANDS = ["repo", "review", "chat", "knowledge", "usage", "analyze-deps", "agent"];

export async function prepareCommandOrganization(argv: string[], orgFlag?: string): Promise<number> {
  const first = argv[0];
  if ((ORGANIZATION_COMMANDS.includes(first) || (orgFlag && ["whoami", "doctor"].includes(first))) && !argv.includes("--help") && !argv.includes("-h")) {
    const saved = await loadStoredCredentials();
    if (saved) {
      let repository = flagValue(argv, "--repo");
      const positional = first === "repo" ? argv[2] : first === "chat" ? argv[1] : undefined;
      if (!repository && positional && /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(positional)) repository = positional;
      const prUrl = flagValue(argv, "--pr");
      if (!repository && prUrl) repository = prUrl.match(/^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\/pull\/\d+\/?$/)?.[1];
      if (!repository) { try { repository = detectOnboardingRepository(); } catch { /* No project: require explicit choice when needed. */ } }
      const resolved = await resolveOrganization(saved, orgFlag, repository);
      if (!resolved.ok) {
        console.error(sanitizeTerminal(resolved.message));
        for (const org of resolved.organizations ?? []) console.error(`  --org ${sanitizeTerminal(org.slug)}  ${sanitizeTerminal(org.name)}`);
        return resolved.state === "organization_required" ? 3 : 1;
      }
      setCommandCredentials(resolved.credentials);
    }
  }
  return 0;
}
