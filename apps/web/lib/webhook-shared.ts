import "server-only";
import { prisma, type Prisma } from "@octopus/db";
import { admitReviewRequest, type ReviewRequestRejection } from "@/lib/review-request-admission";
import { createReviewAttemptComment } from "@/lib/review-attempt";
import { publishReviewSummary } from "@/lib/review-summary-comment";
import { pubby } from "@/lib/pubby";
import { enqueue } from "@/lib/queue";
import { eventBus } from "@/lib/events";
import * as github from "@/lib/github";
import * as bitbucket from "@/lib/bitbucket";
import * as gitlab from "@/lib/gitlab";
import * as forgejo from "@/lib/forgejo";

/**
 * Post a neutral "skipped" check run so the PR isn't blocked forever.
 * GitHub only — Bitbucket and GitLab have no equivalent checks API in this integration.
 */
async function postSkippedCheckRun(
  provider: "github" | "bitbucket" | "gitlab" | "forgejo",
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
 * Works for GitHub, Bitbucket, GitLab, and Forgejo.
 */
/**
 * Outcome of startReviewFlow. Webhooks ignore it; user-facing triggers
 * (CLI / MCP) use it to say why nothing ran instead of "Review started".
 */
export type StartReviewResult =
  | { started: true; pullRequestId: string }
  | ReviewRequestRejection
  | { started: false; reason: "org_paused" | "author_blocked"; message: string };

type StartReviewParams = {
  provider: "github" | "bitbucket" | "gitlab" | "forgejo";
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
  automatic?: boolean;
  triggerCommentId: number;
  triggerCommentBody: string;
};

export async function startReviewFlow(params: StartReviewParams, forgejoTransaction?: Prisma.TransactionClient): Promise<StartReviewResult> {
  if (forgejoTransaction && params.provider !== "forgejo") throw new Error("Transactional webhook admission requires Forgejo");
  return params.provider === "forgejo"
    ? forgejo.runWithForgejoRepository(params.repoId, () => startReviewFlowInternal(params, forgejoTransaction))
    : startReviewFlowInternal(params, forgejoTransaction);
}

async function startReviewFlowInternal(params: StartReviewParams, forgejoTransaction?: Prisma.TransactionClient): Promise<StartReviewResult> {
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

  const admission = await admitReviewRequest(params, forgejoTransaction);
  if (!admission.started) return admission;
  const pr = admission.pullRequest;
  console.log(`[webhook] PullRequest admitted — id: ${pr.id}, number: ${pr.number}`);

  if (forgejoTransaction) {
    const jobId = await enqueue("process-review", { pullRequestId: pr.id }, {
      db: { executeSql: async (sql, values) => ({ rows: await forgejoTransaction.$queryRawUnsafe<unknown[]>(sql, ...(values ?? [])) }) },
    });
    if (!jobId) throw new Error("Forgejo review could not be queued");
    return { started: true, pullRequestId: pr.id };
  }

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
      if (provider === "forgejo" && organizationId) {
        return forgejo.createPullRequestComment(organizationId, repoFullName, prNumber, placeholderBody);
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
  try {
    await enqueue("process-review", { pullRequestId: pr.id });
  } catch (error) {
    // Release only this admission. A provider retry must not be suppressed as
    // already in progress when the durable queue never accepted the job.
    if (provider === "forgejo") await prisma.pullRequest.updateMany({
      where: { id: pr.id, headSha: pr.headSha, reviewRequestVersion: pr.reviewRequestVersion, status: "pending" },
      data: { status: "failed", errorMessage: "Review could not be queued. Retry the request." },
    });
    throw error;
  }
  return { started: true, pullRequestId: pr.id };
}
