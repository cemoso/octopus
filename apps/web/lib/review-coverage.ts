import { createHash } from "node:crypto";
import type { Ignore } from "ignore";
import { buildGeneratedMatcher } from "@/lib/generated-files";

const defaultGenerated = buildGeneratedMatcher();

export type ReviewFileInput = {
  path: string;
  previousPath?: string;
  change: string;
  patch?: string;
  additions?: number;
  deletions?: number;
  blobSha?: string;
  unavailable?: string;
};

export type ReviewInput = {
  provider: string;
  headSha: string | null;
  baseSha: string | null;
  inventoryComplete: boolean;
  expectedFiles: number | null;
  files: ReviewFileInput[];
  limitations: string[];
};

export type FileCoverage = {
  path: string;
  previousPath?: string;
  change: string;
  blobSha?: string;
  state: "supplied" | "partial" | "omitted" | "excluded" | "unavailable";
  reason?: string;
  patchSha256: string | null;
  suppliedSha256: string | null;
  suppliedChars: number;
  hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; sha256: string }[];
};

export type ReviewCoverage = {
  version: 1;
  provider: string;
  headSha: string | null;
  baseSha: string | null;
  inventoryComplete: boolean;
  expectedFiles: number | null;
  complete: boolean;
  files: FileCoverage[];
  limitations: string[];
  nativeCheckId?: string;
  reviewRequestVersion?: number;
  comment?: { receivedChars: number; suppliedChars: number; truncated: boolean; verifiedAsChangedSource: false };
};

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export function unknownReviewCoverage(provider: string, reason: string): ReviewCoverage {
  return { version: 1, provider, headSha: null, baseSha: null, inventoryComplete: false, expectedFiles: null, complete: false, files: [], limitations: [reason] };
}

/** Attach available diff hunks to an independently enumerated manifest. */
export function attachReviewPatches(files: ReviewFileInput[], diff: string): ReviewFileInput[] {
  const patches = new Map<string, string>();
  for (const section of diff.split(/(?=^diff --git )/m)) {
    const path = /^diff --git a\/(.+?) b\/(.+)\n/.exec(section)?.[2];
    const hunkStart = section.search(/^@@ /m);
    if (path && hunkStart >= 0) patches.set(path, section.slice(hunkStart));
  }
  return files.map(file => ({ ...file, patch: file.patch ?? patches.get(file.path) }));
}

// Ordering is a budget preference, never permission to omit a file silently.
export function reviewFilePriority(path: string): number {
  if (/(^|\/)(fixtures?|__fixtures__|snapshots?|__snapshots__)\//i.test(path)) return 3;
  if (/(^|\/)(tests?|__tests__)\/|\.(test|spec)\./i.test(path)) return 2;
  if (/\.(md|txt|rst)$/i.test(path)) return 3;
  return 0;
}

export function isProtectedReviewSource(path: string): boolean {
  return reviewFilePriority(path) <= 2 || /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|c|cpp|h|rb|php|sh|sql|ya?ml|toml)$/i.test(path)
    || /(^|\/)(package\.json|manifest\.json|Dockerfile)$|(^|\/)schemas?\//i.test(path);
}

type Hunk = Omit<FileCoverage["hunks"][number], "sha256"> & { text: string };

/** Validate the provider's hunk counts; a present patch is not necessarily complete. */
export function inspectReviewPatch(patch: string): { hunks: Hunk[]; complete: boolean; additions: number; deletions: number } {
  const lines = patch.replace(/\n$/, "").split("\n");
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let oldSeen = 0, newSeen = 0, additions = 0, deletions = 0;
  let complete = true;
  const finish = () => {
    if (!current) return;
    if (oldSeen === current.oldLines && newSeen === current.newLines) hunks.push(current);
    else complete = false;
  };
  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      finish();
      current = { oldStart: Number(match[1]), oldLines: Number(match[2] ?? 1), newStart: Number(match[3]), newLines: Number(match[4] ?? 1), text: line + "\n" };
      oldSeen = 0; newSeen = 0;
    } else if (current) {
      current.text += line + "\n";
      if (line.startsWith("+")) { newSeen++; additions++; }
      else if (line.startsWith("-")) { oldSeen++; deletions++; }
      else if (line.startsWith(" ")) { oldSeen++; newSeen++; }
      else if (line !== "\\ No newline at end of file") complete = false;
    } else if (line) complete = false;
  }
  finish();
  return { hunks, complete: complete && hunks.length > 0, additions, deletions };
}

function header(file: ReviewFileInput): string | null {
  // Existing inline mapping cannot represent these paths. Preserve them in the
  // manifest as unavailable instead of attributing their hunks to another file.
  if ([file.path, file.previousPath ?? file.path].some(p => /[\r\n\t"\\]| b\//.test(p))) return null;
  const old = file.previousPath ?? file.path;
  return `diff --git a/${old} b/${file.path}\n--- ${file.change === "added" ? "/dev/null" : `a/${old}`}\n+++ ${file.change === "removed" ? "/dev/null" : `b/${file.path}`}\n`;
}

export function prepareReviewInput(input: ReviewInput, options: { maxChars: number; generated?: Ignore; ignored?: Ignore }): { diff: string; coverage: ReviewCoverage; inventoryDiff: string } {
  const budget = Math.max(0, Math.floor(options.maxChars));
  const coverage: ReviewCoverage = { version: 1, provider: input.provider, headSha: input.headSha, baseSha: input.baseSha, inventoryComplete: input.inventoryComplete, expectedFiles: input.expectedFiles, complete: false, limitations: [...input.limitations], files: [] };
  const candidates: { file: ReviewFileInput; record: FileCoverage; header: string; hunks: Hunk[]; complete: boolean }[] = [];
  const seen = new Set<string>();
  for (const file of input.files) {
    if (seen.has(file.path)) { coverage.inventoryComplete = false; coverage.limitations.push("Duplicate changed-file path in provider inventory."); continue; }
    seen.add(file.path);
    const record: FileCoverage = { path: file.path, previousPath: file.previousPath, change: file.change, blobSha: file.blobSha, state: "omitted", reason: "Review input budget exhausted", patchSha256: file.patch === undefined ? null : sha256(file.patch), suppliedSha256: null, suppliedChars: 0, hunks: [] };
    coverage.files.push(record);
    if (options.ignored?.ignores(file.path) || (options.generated?.ignores(file.path) && (!isProtectedReviewSource(file.path) || defaultGenerated.ignores(file.path)))) {
      record.state = "excluded";
      record.reason = options.ignored?.ignores(file.path) ? "Repository .octopusignore policy" : "Generated-file policy";
      continue;
    }
    const fileHeader = header(file);
    if (!fileHeader || file.patch === undefined || file.unavailable) {
      record.state = "unavailable";
      record.reason = !fileHeader ? "Path cannot be mapped safely" : file.unavailable ?? "Provider patch missing (binary or too large)";
      continue;
    }
    const parsed = inspectReviewPatch(file.patch);
    const complete = parsed.complete
      && (file.additions === undefined || file.additions === parsed.additions)
      && (file.deletions === undefined || file.deletions === parsed.deletions);
    if (!parsed.hunks.length) {
      record.state = "unavailable";
      record.reason = "No complete text hunks supplied by provider";
      continue;
    }
    candidates.push({ file, record, header: fileHeader, hunks: parsed.hunks, complete });
  }
  if (coverage.expectedFiles !== null && coverage.expectedFiles !== seen.size) coverage.inventoryComplete = false;
  const ordered = candidates.sort((a, b) => reviewFilePriority(a.file.path) - reviewFilePriority(b.file.path) || a.file.path.localeCompare(b.file.path));
  const parts: string[] = [];
  let remaining = budget;
  // Whole files first. Oversized artifacts cannot monopolize the budget ahead
  // of later source. A second pass uses spare space for complete hunks only.
  for (const candidate of ordered) {
    const text = candidate.header + candidate.hunks.map(h => h.text).join("");
    if (text.length > remaining) continue;
    parts.push(text); remaining -= text.length;
    Object.assign(candidate.record, { state: candidate.complete ? "supplied" : "partial", reason: candidate.complete ? undefined : "Provider patch incomplete", suppliedSha256: sha256(text), suppliedChars: text.length, hunks: candidate.hunks.map(({ text, ...range }) => ({ ...range, sha256: sha256(text) })) });
  }
  for (const candidate of ordered.filter(c => c.record.state === "omitted")) {
    let text = candidate.header;
    const included: Hunk[] = [];
    for (const hunk of candidate.hunks) {
      if (text.length + hunk.text.length > remaining) continue;
      text += hunk.text; included.push(hunk);
    }
    if (!included.length) continue;
    parts.push(text); remaining -= text.length;
    Object.assign(candidate.record, { state: "partial", reason: "Review input budget exhausted", suppliedSha256: sha256(text), suppliedChars: text.length, hunks: included.map(({ text, ...range }) => ({ ...range, sha256: sha256(text) })) });
  }
  coverage.complete = coverage.inventoryComplete && coverage.files.every(f => f.state === "supplied" || f.state === "excluded");
  return { diff: parts.join(""), coverage, inventoryDiff: [...input.files].sort((a, b) => reviewFilePriority(a.path) - reviewFilePriority(b.path)).map(f => header(f) ?? "").join("") };
}

export function coverageCounts(coverage: ReviewCoverage) {
  const count = (state: FileCoverage["state"]) => coverage.files.filter(f => f.state === state).length;
  return { total: coverage.expectedFiles ?? coverage.files.length, supplied: count("supplied"), partial: count("partial"), omitted: count("omitted"), excluded: count("excluded"), unavailable: count("unavailable") };
}

export function reviewCheckResult(coverage: ReviewCoverage, blocking: boolean, findings: number): { conclusion: "failure" | "success"; title: string; summary: string } {
  if (!coverage.complete) return { conclusion: "failure", title: "Review incomplete — missing changed-file coverage", summary: coverageSummary(coverage) };
  return { conclusion: blocking ? "failure" : "success", title: `${coverageCounts(coverage).total} changed files, ${findings} findings`, summary: blocking ? "Issues above the configured severity threshold require attention." : findings > 0 ? "Review scope complete. No issues above the configured threshold." : "Review scope complete. No issues found in the reviewed files." };
}

export function coverageSummary(coverage: ReviewCoverage): string {
  const c = coverageCounts(coverage);
  return `${coverage.complete ? "Review coverage complete" : "Review incomplete"}: ${c.supplied}/${coverage.expectedFiles === null && !coverage.inventoryComplete ? "unknown" : c.total} files fully supplied, ${c.partial} partial, ${c.omitted} omitted, ${c.unavailable} unavailable, ${c.excluded} excluded${coverage.inventoryComplete ? "" : "; changed-file inventory incomplete"}.`;
}

function safeCell(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "&#124;").replaceAll("`", "&#96;").replace(/[\r\n]/g, " "); }

export function renderReviewCoverage(coverage: ReviewCoverage, attemptId: string): string {
  const summary = coverageSummary(coverage);
  const attemptUrl = new URL(`/api/review-attempts/${attemptId}`, process.env.NEXT_PUBLIC_APP_URL ?? "https://octopus-review.ai").href;
  // Full inventory is retained in the immutable attempt; keep provider comments
  // bounded so a huge path list cannot cut the useful findings off GitHub's end.
  const rows = coverage.files.slice(0, 100).map(f => `| ${safeCell(f.path.length > 240 ? f.path.slice(0, 240) + "…" : f.path)} | ${f.state} | ${safeCell((f.reason ?? "All changed text hunks supplied").slice(0, 240))} |`);
  return `### Review coverage\n\n**${summary}**\n\nAttempt: [\`${attemptId}\`](${attemptUrl}). Head: \`${coverage.headSha ?? "unknown"}\`. Base: \`${coverage.baseSha ?? "unknown"}\`.\n\n${coverage.comment ? `Author context: ${coverage.comment.suppliedChars}/${coverage.comment.receivedChars} characters supplied${coverage.comment.truncated ? " (truncated)" : ""}; source excerpts and hashes remain unverified and do not add changed-file coverage.\n\n` : ""}${coverage.complete ? "Coverage describes the supplied review scope; excluded files were not reviewed." : "**Overall: not assessed — incomplete coverage.** Findings apply only to the supplied material; this is not a complete PR assessment."}\n\n<details>\n<summary>Changed-file coverage (${coverage.files.length} known paths)</summary>\n\n| File | Input coverage | Reason |\n| --- | --- | --- |\n${rows.join("\n")}\n${coverage.files.length > 100 ? "\nThe full inventory is stored with this review attempt.\n" : ""}\n</details>\n`;
}

export function applyReviewCoverage(body: string, coverage: ReviewCoverage, attemptId: string): string {
  const assessed = coverage.complete ? body : body.split(/(<!-- OCTOPUS_FINDINGS_START -->[\s\S]*?<!-- OCTOPUS_FINDINGS_END -->)/g).map((part, index) => index % 2 ? part : part
    .replace(/^#{1,6} Score\s*\n[\s\S]*?(?=\n#{1,6} |$)/im, "### Score\n\nNot assessed — incomplete review coverage.\n")
    .replace(/^.*\bOverall\b.*[1-5]\/5.*$/gim, "Overall: not assessed — incomplete review coverage.")).join("");
  return renderReviewCoverage(coverage, attemptId) + "\n" + assessed;
}
