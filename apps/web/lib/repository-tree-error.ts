export const TREE_RESTRICTION_MESSAGE = "GitHub returned HTTP 451 for the repository tree. Automatic retries can resume after 6 hours; you can retry manually.";
export const TREE_RESTRICTION_ERROR_MESSAGE = "GitHub returned HTTP 451 for the repository tree. Check the repository's availability on GitHub, then retry.";

/** A GitHub tree request was refused with HTTP 451. */
export class GitHubTreeRestrictedError extends Error {
  readonly status = 451;
  constructor() { super("Failed to fetch tree: 451"); }
}
