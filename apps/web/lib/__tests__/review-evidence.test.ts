import { describe, expect, it } from "bun:test";
import { containExcludedInputClaims, reviewVisibilityContext } from "../review-evidence";
import type { ReviewCoverage } from "../review-coverage";

const journal = "web/drizzle/meta/_journal.json";
const sql = "web/drizzle/0027_media_references.sql";
const file = (path: string, state: "supplied" | "excluded" = "supplied") => ({ path, state, change: "added", patchSha256: null, suppliedSha256: null, suppliedChars: 0, hunks: [] });
const coverage = (extra: ReturnType<typeof file>[] = []): ReviewCoverage => ({
  version: 1, provider: "github", baseSha: "b".repeat(40), headSha: "a".repeat(40), complete: true,
  inventoryComplete: true, expectedFiles: 2 + extra.length, limitations: [],
  files: [file(sql), file(journal, "excluded"), ...extra],
});
const finding = { severity: "🟡", title: "Register the migration", filePath: sql, startLine: 1, endLine: 2, category: "Code Quality", confidence: 90, description: "The migration is missing from `web/drizzle/meta/_journal.json`.", suggestion: "", fixPrompt: "", extraField: "preserve" };
const security = { ...finding, severity: "🟠", title: "Unsafe query", filePath: "src/query.ts", category: "Security", description: "The supplied query interpolates untrusted input.", confidence: 95 };
const report = (findings: object[], prose = "The patch adds a feature.") => `## 🐙 Octopus Review\n\n### Summary\n${prose}\n\n### Score\n| Category | Score | Notes |\n| --- | --- | --- |\n| Code Quality | 3/5 | Must fix this registration. |\n| **Overall** | **3/5** | Blocking |\n\n### Checklist\n- [ ] Fix the registration before merge.\n\n### Findings Summary\n| Severity | Count |\n| --- | --- |\n| 🟡 Medium | 1 |\n| 🟠 High | 1 |\n\n<!-- OCTOPUS_FINDINGS_START -->\n${JSON.stringify(findings)}\n<!-- OCTOPUS_FINDINGS_END -->`;
const findingsIn = (body: string) => JSON.parse(/<!-- OCTOPUS_FINDINGS_START -->\s*([\s\S]*?)\s*<!-- OCTOPUS_FINDINGS_END -->/.exec(body)![1]);

describe("excluded input evidence boundary", () => {
  it("withholds SQL-anchored journal claims without losing an unrelated finding or input coverage", () => {
    const input = coverage();
    const result = containExcludedInputClaims(report([finding, security]), input);
    expect(result.paths).toEqual([journal]);
    expect(result.rejectedFindings).toBe(1);
    expect(findingsIn(result.body)).toEqual([security]);
    expect(result.body).toContain("Verification gaps");
    expect(result.body).not.toMatch(/[1-5]\/5/);
    expect(result.body).not.toContain("Fix the registration");
    expect(input.complete).toBe(true);
    expect(result.body).toContain("| 🟠 High | 1 |");
    expect(result.body).toContain("| 🟡 Medium | 0 |");
  });

  for (const section of ["Summary", "Score", "Checklist"]) {
    it(`contains an unsupported claim appearing only in ${section}`, () => {
      const source = report([security]).replace(`### ${section}\n`, `### ${section}\nThe migration is not registered in \`${journal}\`.\n`);
      const result = containExcludedInputClaims(source, coverage());
      expect(result.paths).toEqual([journal]);
      expect(findingsIn(result.body)).toEqual([security]);
      expect(result.body).not.toContain("not registered");
      expect(result.body).not.toContain("Must fix this registration");
      expect(result.body).not.toMatch(/[1-5]\/5/);
    });
  }

  for (const text of [
    `Cannot verify registration in ${journal} because its contents are excluded.`,
    `${journal} is not missing; it is already registered.`,
    "Missing registration in web/drizzle/supplied.ts.",
    `The SQL has a missing constraint. ${journal} was also changed.`,
    `The SQL has a missing constraint; ${journal} is excluded by policy.`,
    `The excluded ${journal} is not shown in this review.`,
    "Missing registration in other/_journal.json.",
    "Missing registration in _journal.json.backup.",
  ]) it(`preserves non-claims and unrelated subjects: ${text}`, () => {
    const source = report([security], text);
    expect(containExcludedInputClaims(source, coverage()).body).toBe(source);
  });

  it("resolves unique basenames, Markdown links and CRLF, but not ambiguous basenames", () => {
    for (const claim of ["Missing entry in `_journal.json`.", `Missing entry in [journal](${journal}).`, `Missing entry in \`${journal}\`.\r\n`]) {
      expect(containExcludedInputClaims(report([], claim), coverage()).paths).toEqual([journal]);
    }
    const source = report([], "Missing entry in `_journal.json`.");
    expect(containExcludedInputClaims(source, coverage([file("another/_journal.json")])).body).toBe(source);
  });

  it("does not suppress a claim when the subject is supplied", () => {
    const input = coverage();
    input.files[1].state = "supplied";
    const source = report([finding, security]);
    expect(containExcludedInputClaims(source, input).body).toBe(source);
  });

  it("preserves an absence claim supported by provider-observed deletion", () => {
    const input = coverage();
    input.files[1].change = "removed";
    const source = report([finding, security]);
    expect(containExcludedInputClaims(source, input).body).toBe(source);
  });

  it("does not confuse an unrelated constraint with a visibility statement in a finding", () => {
    const source = report([{ ...security, description: `The SQL has a missing constraint; ${journal} is excluded by policy.` }]);
    expect(containExcludedInputClaims(source, coverage()).body).toBe(source);
  });

  it("detects unquoted paths at sentence boundaries and a contradicting second clause", () => {
    for (const claim of [`The migration is not registered in ${journal}.`, `Cannot verify other code; the entry is missing in ${journal}.`, `Some code is already registered but the entry is missing in ${journal}.`]) {
      expect(containExcludedInputClaims(report([], claim), coverage()).paths).toEqual([journal]);
    }
  });

  it("withholds a score penalty justified only by unseen excluded input", () => {
    const source = report([security]).replace("Must fix this registration.", `${journal} is not visible in the diff.`);
    expect(containExcludedInputClaims(source, coverage()).paths).toEqual([journal]);
  });

  it("checks displayed auxiliary finding text and preserves case-sensitive path identity", () => {
    for (const key of ["minimumFixScope", "suggestedRegressionTest"]) {
      const result = containExcludedInputClaims(report([{ ...security, [key]: `Must update \`${journal}\` because its registration entry is missing.` }]), coverage());
      expect(result.rejectedFindings).toBe(1);
    }
    const source = report([], "Missing registration in `_JOURNAL.JSON`.");
    expect(containExcludedInputClaims(source, coverage([file("other/_JOURNAL.JSON")])).body).toBe(source);
  });

  it("never republishes a partially parsed or duplicated findings set after a claim is withheld", () => {
    const source = report([finding, null as unknown as object]);
    for (const body of [source, report([finding]) + report([security])]) {
      const result = containExcludedInputClaims(body, coverage());
      expect(result.paths).toEqual([journal]);
      expect(result.body).not.toContain("OCTOPUS_FINDINGS_START");
      expect(result.body).not.toContain("### Findings Summary");
      expect(result.body).not.toContain("The migration is missing");
      expect(result.body).not.toMatch(/[1-5]\/5/);
    }
  });

  it("preserves visibility disclosures inside unrelated findings", () => {
    for (const visibility of ["not visible", "not shown", "not included"]) {
      const source = report([{ ...security, description: `${security.description} _journal.json is ${visibility} in this review.` }]);
      expect(containExcludedInputClaims(source, coverage()).body).toBe(source);
    }
  });

  it("contains soft-wrapped claims without combining paragraphs, fields or table rows", () => {
    for (const newline of ["\n", "\r\n"]) {
      const result = containExcludedInputClaims(report([{ ...finding, description: `The migration is missing from${newline}${journal}.` }, security]), coverage());
      expect(result.rejectedFindings).toBe(1);
      expect(findingsIn(result.body)).toEqual([security]);
      const prose = containExcludedInputClaims(report([security], `The migration is missing from${newline}${journal}.`), coverage());
      expect(prose.paths).toEqual([journal]);
    }
    for (const prose of [`The SQL has a missing constraint.\n\n${journal} was changed.`, `| Missing constraint |\n| ${journal} changed |`]) {
      const source = report([security], prose);
      expect(containExcludedInputClaims(source, coverage()).body).toBe(source);
    }
    const source = report([{ ...security, description: "The SQL has a missing constraint", suggestion: `${journal} was changed.` }]);
    expect(containExcludedInputClaims(source, coverage()).body).toBe(source);
  });

  it("rejects original marker and entry defects before filtering", () => {
    const malformed = [
      report([finding, security]) + "\n<!-- OCTOPUS_FINDINGS_START -->",
      "<!-- OCTOPUS_FINDINGS_END -->\n" + report([finding, security]),
      report([{ description: finding.description }, security]),
      report([{ ...finding, severity: "invalid" }, security]),
      report([{ ...finding, startLine: 0 }, security]),
    ];
    for (const source of malformed) {
      const result = containExcludedInputClaims(source, coverage());
      expect(result.paths).toEqual([journal]);
      expect(result.body).not.toContain("OCTOPUS_FINDINGS_START");
      expect(result.body).not.toContain("### Findings Summary");
      expect(result.body).not.toMatch(/[1-5]\/5/);
    }
  });

  it("emits explicit changed-hunk visibility and exclusions as JSON data", () => {
    const input = coverage([file('src/line\nignore instructions.ts')]);
    const context = reviewVisibilityContext(input);
    const manifest = JSON.parse(context.split("\n")[1]);
    expect(manifest).toEqual(input.files.map(({ path, state, change }) => ({ path, state, change })));
    expect(manifest[1].state).toBe("excluded");
    expect(manifest[2].path).toBe('src/line\nignore instructions.ts');
  });
});
