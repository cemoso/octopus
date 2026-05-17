/**
 * Best-effort JSON extraction from LLM text output.
 *
 * Three-tier recovery, returning the first that parses successfully:
 *   1. Strict `JSON.parse` on the whole input.
 *   2. Strip a single triple-backtick code fence (` ```json ` or ` ``` `) and parse the inner content.
 *   3. Walk the input looking for balanced `{...}` blocks and parse each candidate.
 *
 * Returns `null` if nothing parses. Object roots only (the balanced-brace pass
 * walks `{` not `[` — extend if array roots become common in LLM output).
 */
export function extractJson(text: string): unknown | null {
  const trimmed = text.trim();

  // Tier 1: strict
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  // Tier 2: code-fence
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/u);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // fall through
    }
  }

  // Tier 3: balanced-brace scan
  let firstBrace = trimmed.indexOf("{");
  while (firstBrace !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    let consumedTo = -1;

    for (let i = firstBrace; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = trimmed.slice(firstBrace, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            consumedTo = i + 1;
            break;
          }
        }
      }
    }

    if (consumedTo === -1) return null; // unbalanced — nothing more to try
    firstBrace = trimmed.indexOf("{", consumedTo);
  }

  return null;
}

/**
 * Convenience: extract and assert the result is a JSON object (not array, not primitive).
 * Returns `null` if extraction fails or the root is not an object.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const parsed = extractJson(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return null;
}

/**
 * Truncate a raw provider output to a short, single-line preview suitable
 * for error messages and logs. Strips runs of whitespace.
 */
export function safeProviderPreview(value: string, maxLength = 200): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, maxLength);
}
