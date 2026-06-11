import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Drift guard for the bare-review prompt template substitution.
 *
 * The original H8 audit finding was that `generateBareLocalReview`'s
 * `.replace(/\{\{X\}\}/g, "")` chain used placeholder names that DIDN'T
 * exist in `apps/web/prompts/SYSTEM_PROMPT.md` (REPO_NAME, PR_TITLE,
 * CONTEXT_BLOCK, etc.) — and the placeholders that the template DID
 * contain (CODEBASE_CONTEXT, FILE_TREE, USER_INSTRUCTION, ...) were
 * never replaced. Every `octp review` bare call shipped literal
 * `{{FILE_TREE}}` strings to the model under instructions that told
 * it to treat them as authoritative context.
 *
 * This test asserts that every `{{PLACEHOLDER}}` appearing in
 * SYSTEM_PROMPT.md is also in the bare-mode replace chain. It's a
 * source-level grep rather than a runtime check so it stays cheap and
 * doesn't need the LLM call infrastructure.
 *
 * Update path when the prompt template changes:
 *   1. Add the new {{...}} placeholder to SYSTEM_PROMPT.md.
 *   2. Add the matching `.replace(/\{\{NAME\}\}/g, ...)` in
 *      generateBareLocalReview (review-core.ts).
 */

const REPO_ROOT = join(__dirname, "..", "..");
const PROMPT_PATH = join(REPO_ROOT, "prompts", "SYSTEM_PROMPT.md");
const REVIEW_CORE_PATH = join(REPO_ROOT, "lib", "review-core.ts");

function extractPlaceholders(text: string): Set<string> {
  const out = new Set<string>();
  const re = /\{\{([A-Z_]+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return out;
}

function extractBareReplaceChain(source: string): Set<string> {
  // Slice the file to the generateBareLocalReview body so we don't
  // accidentally count placeholders the canonical generateLocalReview
  // uses (those may legitimately differ — generateLocalReview has the
  // repo/PR context the bare path doesn't).
  const start = source.indexOf("export async function generateBareLocalReview");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\nexport ", start + 1);
  const body = source.slice(start, end === -1 ? undefined : end);

  const out = new Set<string>();
  // Pattern in source: .replace(/\{\{NAME\}\}/g, "...")
  const re = /\\\{\\\{([A-Z_]+)\\\}\\\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return out;
}

describe("bare-review prompt template substitution", () => {
  test("every SYSTEM_PROMPT.md placeholder has a matching replace() call", () => {
    const promptText = readFileSync(PROMPT_PATH, "utf8");
    const sourceText = readFileSync(REVIEW_CORE_PATH, "utf8");

    const required = extractPlaceholders(promptText);
    const handled = extractBareReplaceChain(sourceText);

    const missing = [...required].filter((p) => !handled.has(p)).sort();
    expect({ missing, required: [...required].sort(), handled: [...handled].sort() }).toMatchObject({
      missing: [],
    });
  });

  test("no placeholder in the replace chain that doesn't exist in the prompt (dead code guard)", () => {
    const promptText = readFileSync(PROMPT_PATH, "utf8");
    const sourceText = readFileSync(REVIEW_CORE_PATH, "utf8");

    const required = extractPlaceholders(promptText);
    const handled = extractBareReplaceChain(sourceText);

    const orphans = [...handled].filter((p) => !required.has(p)).sort();
    expect({ orphans, handled: [...handled].sort() }).toMatchObject({ orphans: [] });
  });
});
