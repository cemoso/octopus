import { createHash } from "node:crypto";

const policy = "github-binary-png-v1" as const;
const fullSha = /^[0-9a-f]{40}$/;
const prefix = /^[0-9a-f]{7,40}$/;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

type Revision = { provider: string; headSha: string | null; baseSha: string | null };
type File = { path: string; previousPath?: string; change: string; patch?: string; additions?: number; deletions?: number; blobSha?: string; unavailable?: string };
type BinarySection = { path: string; change: "added" | "modified"; newBlobPrefix: string; rawSection: string; rawSectionSha256: string };

export type BinaryPngEvidence = {
  policy: typeof policy;
  provider: "github";
  headSha: string;
  baseSha: string;
  path: string;
  change: "added" | "modified";
  blobSha: string;
  rawSection: string;
  rawSectionSha256: string;
};

function safePngPath(path: string): boolean {
  return path.length <= 4096 && /^[a-zA-Z0-9._/-]+\.png$/i.test(path)
    && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

/** Accept only complete ordinary-file declarations, never a marker in a hunk. */
function parseBinarySection(rawSection: string): BinarySection | undefined {
  const lines = rawSection.replace(/\n$/, "").split("\n");
  const paths = /^diff --git a\/(.+?) b\/(.+)$/.exec(lines[0] ?? "");
  if (!paths || paths[1] !== paths[2] || !safePngPath(paths[2])) return;
  const path = paths[2];
  const added = lines.length === 4 && lines[1] === "new file mode 100644";
  const modified = lines.length === 3;
  if (!added && !modified) return;
  const index = /^index ([0-9a-f]+)\.\.([0-9a-f]+)( 100644)?$/.exec(lines[added ? 2 : 1]);
  if (!index || !prefix.test(index[1]) || !prefix.test(index[2]) || /^0+$/.test(index[2])) return;
  if (added) {
    if (!/^0+$/.test(index[1]) || index[3] !== undefined) return;
  } else if (/^0+$/.test(index[1]) || index[1].startsWith(index[2]) || index[2].startsWith(index[1]) || index[3] !== " 100644") return;
  if (lines.at(-1) !== `Binary files ${added ? "/dev/null" : `a/${path}`} and b/${path} differ`) return;
  return { path, change: added ? "added" : "modified", newBlobPrefix: index[2], rawSection, rawSectionSha256: digest(rawSection) };
}

/** Index once; any duplicate old/new path invalidates its candidate evidence. */
export function indexGitHubBinaryPngSections(rawDiff: string): Map<string, BinarySection> {
  const candidates = new Map<string, BinarySection>();
  const seen = new Set<string>();
  const conflicts = new Set<string>();
  for (const section of rawDiff.split(/(?=^diff --git )/m)) {
    if (!section) continue;
    const paths = /^diff --git a\/(.+?) b\/(.+)\n/.exec(section);
    // Uninterpretable headers could alias another path (for example Git's
    // quoted path syntax). Do not authorize new exclusions in that case.
    if (!paths) return new Map();
    for (const path of new Set([paths[1], paths[2]])) {
      if (seen.has(path)) { conflicts.add(path); candidates.delete(path); }
      seen.add(path);
    }
    const parsed = parseBinarySection(section);
    if (parsed && !conflicts.has(parsed.path)) candidates.set(parsed.path, parsed);
  }
  return candidates;
}

/** Bind a provider declaration to independently fetched file/revision metadata. */
export function createBinaryPngEvidence(file: File, revision: Revision, section: BinarySection | undefined): BinaryPngEvidence | undefined {
  if (!section || revision.provider !== "github" || !revision.headSha || !revision.baseSha
    || !fullSha.test(revision.headSha) || !fullSha.test(revision.baseSha)
    || /^0+$/.test(revision.headSha) || /^0+$/.test(revision.baseSha)
    || file.previousPath !== undefined || file.patch !== undefined || file.unavailable !== undefined
    || file.additions !== 0 || file.deletions !== 0 || !file.blobSha || !fullSha.test(file.blobSha)
    || file.path !== section.path || file.change !== section.change || !file.blobSha.startsWith(section.newBlobPrefix)) return;
  return {
    policy, provider: "github", headSha: revision.headSha, baseSha: revision.baseSha,
    path: file.path, change: section.change, blobSha: file.blobSha,
    rawSection: section.rawSection, rawSectionSha256: section.rawSectionSha256,
  };
}

/** Preparation rechecks the receipt before retaining it in the immutable manifest. */
export function validateBinaryPngEvidence(file: File, revision: Revision, evidence: BinaryPngEvidence | undefined): BinaryPngEvidence | undefined {
  if (!evidence || typeof evidence.rawSection !== "string") return;
  const verified = createBinaryPngEvidence(file, revision, parseBinarySection(evidence.rawSection));
  if (!verified || (Object.keys(verified) as (keyof BinaryPngEvidence)[]).some(key => evidence[key] !== verified[key])) return;
  return verified;
}
