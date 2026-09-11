import { mock } from "bun:test";
import assert from "node:assert/strict";
mock.module("server-only", () => ({}));
mock.module("@/lib/github-app-config", () => ({ getGithubAppConfig: async () => ({ appId: "98765" }) }));
const { findPullRequestSummaryComment } = await import("../../github");
const marker = "<!-- octopus-summary:pr:42 -->";
let comments: unknown[] = [
  { id: 1, body: marker, user: { type: "User" } },
  { id: 2, body: marker, performed_via_github_app: { id: 123 } },
  { id: 3, body: `${marker}-copy`, performed_via_github_app: { id: 98765 } },
  { id: 4, body: `Summary\n${marker}`, performed_via_github_app: { id: 98765 } },
];
globalThis.fetch = (async () => Response.json(comments)) as typeof fetch;
assert.equal(await findPullRequestSummaryComment("fixture", "repo", 1, marker, "token", AbortSignal.timeout(1000)), 4);
comments = comments.slice(0, 3);
assert.equal(await findPullRequestSummaryComment("fixture", "repo", 1, marker, "token", AbortSignal.timeout(1000)), null);
console.log("PASS authentic app and exact marker reconciliation");
