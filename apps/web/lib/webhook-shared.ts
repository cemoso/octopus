import "server-only";
import { prisma } from "@octopus/db";
import { admitReviewRequest, type ReviewRequestRejection } from "@/lib/review-request-admission";
import { createReviewAttemptComment } from "@/lib/review-attempt";
import { publishReviewSummary } from "@/lib/review-summary-comment";
import { pubby } from "@/lib/pubby";
import { enqueue } from "@/lib/queue";
import { eventBus } from "@/lib/events";
import * as github from "@/lib/github";
import * as bitbucket from "@/lib/bitbucket";
import * as gitlab from "@/lib/gitlab";

/**
 * Post a neutral "skipped" check run so the PR isn't blocked forever.
 * GitHub only — Bitbucket and GitLab have no equivalent checks API in this integration.
 */
async function postSkippedCheckRun(
  provider: "github" | "bitbucket" | "gitlab",
  installationId: number | undefined,
  repoFullName: string,
  headSha: string,
  reason: string,
) {
  if (provider !== "github" || !installationId || !headSha) return;
  const [owner, repo] = repoFullName.split("/");
  try {
    const checkRunId = await github.createCheckRun(installationId, owner, repo, headSha, "Octopus Review");
    await github.updateCheckRun(installationId, owner, repo, checkRunId, "neutral", {
      title: "Review skipped",
      summary: reason,
    });
    console.log(`[webhook] Check run marked as neutral — ${reason}`);
  } catch (err) {
    console.warn("[webhook] Failed to post neutral check run:", err);
  }
}

/**
 * Shared flow: admit the current head -> post placeholder comment -> notify dashboard -> start review.
 * Works for GitHub, Bitbucket, and GitLab.
 */
/**
 * Outcome of startReviewFlow. Webhooks ignore it; user-facing triggers
 * (CLI / MCP) use it to say why nothing ran instead of "Review started".
 */
export type StartReviewResult =
  | { started: true; pullRequestId: string }
  | ReviewRequestRejection
  | { started: false; reason: "org_paused" | "author_blocked"; message: string };

export async function startReviewFlow(params: {
  provider: "github" | "bitbucket" | "gitlab";
  // GitHub-specific
  installationId?: number;
  // Bitbucket / GitLab-specific
  organizationId?: string;
  // Common
  repoFullName: string;
  repoId: string;
  orgId: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  prAuthor: string;
  headSha: string | null;
  triggerCommentId: number;
  triggerCommentBody: string;
}): Promise<StartReviewResult> {
  const {
    provider,
    installationId,
    organizationId,
    repoFullName,
    repoId,
    orgId,
    prNumber,
    prTitle,
    prUrl,
    prAuthor,
    headSha,
  } = params;

  const [owner, repoName] = repoFullName.split("/");

  // Check if reviews are paused for this organization
  const [org, systemConfig] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { reviewsPaused: true, blockedAuthors: true },
    }),
    prisma.systemConfig.findUnique({
      where: { id: "singleton" },
      select: { blockedAuthors: true },
    }),
  ]);

  if (org?.reviewsPaused) {
    console.log(`[webhook] Reviews paused for org ${orgId}, skipping PR #${prNumber}`);
    return { started: false, reason: "org_paused", message: "Reviews are paused for this organization" };
  }

  // Check if PR author is blocked from triggering reviews
  if (prAuthor) {
    const globalBlocked = (systemConfig?.blockedAuthors as string[]) ?? [];
    const orgBlocked = (org?.blockedAuthors as string[]) ?? [];
    const authorLower = prAuthor.toLowerCase();
    const isBlocked = [...globalBlocked, ...orgBlocked].some(
      (b) => b.toLowerCase() === authorLower,
    );
    if (isBlocked) {
      console.log(`[webhook] PR author "${prAuthor}" is blocked for org ${orgId}, skipping PR #${prNumber}`);
      await postSkippedCheckRun(provider, installationId, repoFullName, headSha || "", `PR author "${prAuthor}" is in the blocked list`);
      return { started: false, reason: "author_blocked", message: `PR author "${prAuthor}" is in the blocked list` };
    }
  }

  const admission = await admitReviewRequest(params);
  if (!admission.started) return admission;
  const pr = admission.pullRequest;
  console.log(`[webhook] PullRequest admitted — id: ${pr.id}, number: ${pr.number}`);

  const placeholderBody = `> 🐙 **Octopus Review** is queued for head \`${pr.headSha || "unknown"}\`. This summary will update when the review finishes.`;
  try {
    if (provider === "github" && installationId) {
      await publishReviewSummary({ pullRequestId: pr.id, headSha: pr.headSha, reviewRequestVersion: pr.reviewRequestVersion,
        installationId, owner, repo: repoName, prNumber, body: placeholderBody });
    } else await createReviewAttemptComment(pr.id, pr.headSha, pr.reviewRequestVersion, async () => {
      if (provider === "bitbucket" && organizationId) {
        return bitbucket.createPullRequestComment(organizationId, owner, repoName, prNumber, placeholderBody);
      }
      if (provider === "gitlab" && organizationId) {
        return gitlab.createPullRequestComment(organizationId, repoFullName, prNumber, placeholderBody);
      }
      throw new Error("Invalid provider configuration");
    });
  } catch (err) {
    console.error("[webhook] Failed to post placeholder comment:", err);
  }

  // Notify real-time dashboard
  const channel = `presence-org-${orgId}`;
  pubby
    .trigger(channel, "review-requested", {
      repoId,
      pullRequest: {
        id: pr.id,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author,
        status: pr.status,
        headSha: pr.headSha,
        reviewRequestVersion: pr.reviewRequestVersion,
        createdAt: pr.createdAt.toISOString(),
      },
    })
    .catch((err) => console.error("[webhook] Pubby trigger failed:", err));

  eventBus.emit({
    type: "review-requested",
    orgId,
    prNumber,
    prTitle,
    prAuthor,
    prUrl,
  });

  // Enqueue review job — pg-boss persists it in DB, survives container restarts
  await enqueue("process-review", { pullRequestId: pr.id });
  return { started: true, pullRequestId: pr.id };
}
