import { flagValue, positionals } from "./args.js";
import { loadStoredCredentials, setCommandCredentials } from "./credentials.js";
import { resolveOrganization } from "./organizations.js";
import { detectOnboardingRepository } from "./git-repository.js";
import { parsePrArg, reviewPrArgument } from "./pr-url.js";
import { sanitizeTerminal } from "./output.js";

export const ORGANIZATION_COMMANDS = ["repo", "review", "chat", "knowledge", "usage", "analyze-deps"];

export function isOrganizationCommand(argv: string[]): boolean {
  return ORGANIZATION_COMMANDS.includes(argv[0]) || (argv[0] === "agent" && argv[1] === "serve");
}

export async function prepareCommandOrganization(argv: string[], orgFlag?: string): Promise<number> {
  const first = argv[0];
  if ((isOrganizationCommand(argv) || (orgFlag && ["whoami", "doctor"].includes(first))) && !argv.includes("--help") && !argv.includes("-h")) {
    const saved = await loadStoredCredentials();
    if (saved) {
      let repository = flagValue(argv, "--repo");
      const positional = first === "repo" ? argv[2] : first === "chat" ? argv[1] : undefined;
      if (!repository && positional && /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(positional)) repository = positional;
      let useRemote = true;
      if (first === "review") {
        const target = reviewPrArgument(argv.slice(1));
        if (target) {
          const parsed = parsePrArg(target);
          if (!parsed.ok) { console.error(sanitizeTerminal(parsed.error)); return 2; }
          repository = parsed.repoFullName;
        }
      } else if (first === "analyze-deps") {
        const target = positionals(argv.slice(1))[0];
        useRemote = !target;
        if (target) {
          try {
            const url = new URL(target.trim());
            const parts = url.pathname.split("/").filter(Boolean);
            if (url.hostname !== "github.com" || parts.length < 2) throw new Error();
            repository = parts.slice(0, 2).join("/");
          } catch { console.error("Invalid GitHub repository URL."); return 2; }
        }
      }
      if (!repository && useRemote) { try { repository = detectOnboardingRepository(); } catch { /* No project: require explicit choice when needed. */ } }
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
