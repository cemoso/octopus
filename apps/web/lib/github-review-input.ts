import { reviewFilePriority, type ReviewInput, type ReviewFileInput } from "@/lib/review-coverage";

type PullMetadata = { head?: { sha?: string }; base?: { sha?: string }; changed_files?: number };
type ChangedFile = { filename: string; previous_filename?: string; status: string; patch?: string; additions?: number; deletions?: number; sha?: string };

/** Fetch the complete inventory independently of diff size. No comment or diff
 * content can declare coverage; only provider pagination and pinned revisions do. */
export async function fetchGitHubReviewInput(options: {
  readJson: (suffix: string) => Promise<unknown>;
  fetchDiff: () => Promise<string>;
  expectedHead: string | null;
  maxPatchChars: number;
}): Promise<{ input: ReviewInput; rawDiff: string }> {
  const before = await options.readJson("") as PullMetadata;
  if (!before.head?.sha || !before.base?.sha || (options.expectedHead && before.head.sha !== options.expectedHead)) {
    throw new Error("PR revision changed before review input was fetched");
  }
  // Preserve the existing large-PR delegation boundary. That path must also
  // report unknown coverage until it has an independently verified inventory.
  const rawDiff = await options.fetchDiff();
  const files: ReviewFileInput[] = [];
  let sourceChars = 0, supportingChars = 0;
  let inventoryComplete = false;
  const expectedFiles = Number.isSafeInteger(before.changed_files) && before.changed_files! >= 0 ? before.changed_files! : null;
  for (let page = 1; page <= 30; page++) {
    const response = await options.readJson(`/files?per_page=100&page=${page}`);
    if (!Array.isArray(response)) throw new Error("Invalid GitHub changed-file response");
    for (const value of response) {
      const file = value as ChangedFile;
      if (typeof file.filename !== "string" || typeof file.status !== "string") throw new Error("Invalid GitHub changed-file entry");
      const source = reviewFilePriority(file.filename) === 0;
      const remaining = source ? options.maxPatchChars * 2 - sourceChars : options.maxPatchChars / 2 - supportingChars;
      const patch = typeof file.patch === "string" && file.patch.length <= Math.min(options.maxPatchChars, remaining) ? file.patch : undefined;
      if (source) sourceChars += patch?.length ?? 0;
      else supportingChars += patch?.length ?? 0;
      files.push({ path: file.filename, previousPath: file.previous_filename, change: file.status, patch, additions: file.additions, deletions: file.deletions, blobSha: file.sha, unavailable: typeof file.patch === "string" && patch === undefined ? "File exceeds retained patch budget" : undefined });
    }
    if (response.length < 100 || (expectedFiles !== null && files.length >= expectedFiles)) {
      inventoryComplete = expectedFiles !== null && files.length === expectedFiles;
      break;
    }
  }
  const after = await options.readJson("") as PullMetadata;
  if (after.head?.sha !== before.head.sha || after.base?.sha !== before.base.sha || after.changed_files !== before.changed_files) {
    throw new Error("PR revision changed while review input was being fetched");
  }
  return { rawDiff, input: { provider: "github", headSha: before.head.sha, baseSha: before.base.sha, expectedFiles, inventoryComplete, files, limitations: inventoryComplete ? [] : ["GitHub changed-file pagination or file count is incomplete (maximum 3,000 files)."] } };
}
