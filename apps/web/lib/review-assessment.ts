import type { AiCreateParams, AiResponse } from "@/lib/providers";
import type { AiRequestReceipt } from "@/lib/providers/request-evidence";
import { sha256, type ReviewCoverage } from "@/lib/review-coverage";
import { parseFindingsFromJson } from "@/lib/review-dedup";

export type ReviewAssessment = {
  state: "completed" | "incomplete" | "not-required";
  reason: string;
  model: string | null;
  policySha256: string;
  templateSha256: string;
  requests: AiRequestReceipt[];
  responseSha256: string | null;
  completion: AiResponse["completion"] | null;
};

/** Validate the emitted report contract, independently of provider termination. */
export function validReviewResponse(text: string): boolean {
  if ((text.match(/^## 🐙 Octopus Review\s*$/gm) ?? []).length !== 1
    || (text.match(/^### Score\s*$/gm) ?? []).length !== 1
    || !/^### Summary\s*\n\s*\S/m.test(text)) return false;
  const score = /^### Score\s*\n([\s\S]*?)(?=\n#{1,6} |(?![\s\S]))/m.exec(text)?.[1] ?? "";
  if (!/^\|\s*Category\s*\|\s*Score\s*\|\s*Notes\s*\|\s*$/m.test(score)) return false;
  for (const category of ["Security", "Code Quality", "Performance", "Error Handling", "Consistency"]) {
    const rows = score.split("\n").filter(line => line.split("|")[1]?.trim().replaceAll("**", "") === category);
    if (rows.length !== 1 || rows[0].split("|").length !== 5
      || !/^(?:[1-5]\/5|N\/A)$/.test(rows[0].split("|")[2].trim().replaceAll("**", ""))) return false;
  }
  const overall = score.split("\n").filter(line => /Overall/i.test(line));
  if (overall.length !== 1 || !/^\|\s*\*\*Overall\*\*\s*\|\s*\*\*[1-5]\/5\*\*\s*\|[^|]+\|\s*$/.test(overall[0])) return false;
  return validReviewFindings(text);
}

export function validReviewFindings(text: string): boolean {
  const matches = [...text.matchAll(/<!-- OCTOPUS_FINDINGS_START -->\s*([\s\S]*?)\s*<!-- OCTOPUS_FINDINGS_END -->/g)];
  if (matches.length !== 1
    || text.split("<!-- OCTOPUS_FINDINGS_START -->").length !== 2
    || text.split("<!-- OCTOPUS_FINDINGS_END -->").length !== 2) return false;
  try {
    const block = matches[0][1].trim();
    const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(block);
    const findings: unknown = JSON.parse(fenced ? fenced[1] : block);
    if (!Array.isArray(findings)
      || (findings.length > 0 && parseFindingsFromJson(text)?.length !== findings.length)) return false;
    const severities = ["🔴", "🟠", "🟡", "🔵", "💡"];
    if (findings.some(finding => !severities.includes(finding.severity)
      || !Number.isInteger(finding.startLine) || finding.startLine < 1)) return false;
    const summaries = [...text.matchAll(/^### Findings Summary[ \t]*\r?\n([\s\S]*?)(?=^#{1,6} |<!-- OCTOPUS_FINDINGS_START -->|(?![\s\S]))/gm)];
    if (summaries.length !== 1) return false;
    const summary = summaries[0][1].trim();
    const lines = summary.split("\n").map(line => line.trim()).filter(Boolean);
    if (!/^\|\s*Severity\s*\|\s*Count\s*\|$/.test(lines[0] ?? "")
      || !/^\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|$/.test(lines[1] ?? "")) return false;
    const counts = new Map<string, number>();
    for (const line of lines.slice(2)) {
      const row = /^\|\s*(🔴|🟠|🟡|🔵|💡)[^|]*\|\s*(\d+)\s*\|$/.exec(line);
      if (!row || counts.has(row[1]) || !Number.isSafeInteger(Number(row[2]))) return false;
      counts.set(row[1], Number(row[2]));
    }
    return severities.every(severity =>
      (counts.get(severity) ?? 0) === findings.filter(finding => finding.severity === severity).length);
  } catch { return false; }
}

export function recordNoModelAssessment(coverage: ReviewCoverage): void {
  const excludedOnly = coverage.inventoryComplete && coverage.files.length > 0
    && coverage.files.every(file => file.state === "excluded");
  coverage.assessment = {
    state: excludedOnly ? "not-required" : "incomplete",
    reason: excludedOnly ? "All changed paths explicitly excluded by policy; no model assessment performed" : "No eligible changed input available for assessment",
    model: null, policySha256: sha256(JSON.stringify(coverage)), templateSha256: sha256("no-model-v1"),
    requests: [], responseSha256: null, completion: null,
  };
  coverage.complete = coverage.complete && excludedOnly;
}

/** The caller persists this digest-only record together with the final outcome. */
export async function executeCoveredReview(
  request: AiCreateParams, coverage: ReviewCoverage, template: string,
  call: (request: AiCreateParams) => Promise<AiResponse>,
): Promise<AiResponse> {
  const assessment: ReviewAssessment = {
    state: "incomplete", reason: "Provider did not return a completed assessment", model: request.model,
    policySha256: sha256(JSON.stringify({ policy: "bounded-review-assessment-v1", coverage })),
    templateSha256: sha256(template), requests: [], responseSha256: null, completion: null,
  };
  coverage.assessment = assessment;
  let response: AiResponse;
  try {
    response = await call({ ...request, onRequest: receipt => assessment.requests.push(receipt) });
  } catch (error) {
    coverage.complete = false;
    assessment.reason = "Provider request failed or was interrupted";
    throw error;
  }
  assessment.responseSha256 = sha256(response.text);
  assessment.completion = response.completion ?? null;
  const valid = validReviewResponse(response.text);
  const observed = assessment.requests.length === 1 && assessment.requests[0].model === response.model
    && assessment.requests[0].provider === response.provider && assessment.requests[0].inputPreserved;
  assessment.state = observed && valid && response.completion?.state === "completed" ? "completed" : "incomplete";
  assessment.reason = !observed ? "Actual provider request provenance unavailable"
    : !valid ? "Empty or malformed review response"
      : response.completion?.state !== "completed" ? "Provider completion incomplete or unknown"
        : "Provider completed a valid review response";
  coverage.complete = coverage.complete && assessment.state === "completed";
  return response;
}
