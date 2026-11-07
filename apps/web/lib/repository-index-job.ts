import "server-only";
import { reportBackgroundFailure, type RetryState } from "./background-failure";
import { randomUUID } from "node:crypto";
import { runRepositoryIndex, SupersededIndexError, isIndexingCancelled, treeRestrictionEligible } from "@/lib/repository-index-completion";
import { prisma } from "@octopus/db";
import { enqueue } from "@/lib/queue";
import type { LogLevel } from "@/lib/indexer";
import { notifyRepositoryIndex } from "@/lib/repository-index-notifications";
import { deleteSyncLogs, writeSyncLog } from "@/lib/elasticsearch";
import { createAbortController, clearAbortController } from "@/lib/indexing-abort";
import { GitHubTreeRestrictedError, TREE_RESTRICTION_MESSAGE } from "@/lib/repository-tree-error";

export interface RepositoryIndexJob {
  repositoryId: string;
  organizationId: string;
}

// Revisit empty snapshots as well: a repository can be discovered before its
// first push. Failed enqueues remain eligible for the next discovery sweep.
const needsIndex = (now: Date, installationId: number | null) => ({
  AND: [treeRestrictionEligible(now, installationId)],
  OR: [
    { indexStatus: "pending" },
    { indexStatus: "failed" },
    { indexStatus: "indexed", totalFiles: 0 },
  ],
});

function treeRetryDeferred(repo: { provider: string; indexStatus: string; indexRetryAfter: Date | null; indexRetryInstallationId: number | null }, installationId: number | null): boolean {
  return repo.provider === "github" && ["pending", "failed"].includes(repo.indexStatus) && installationId !== null && repo.indexRetryInstallationId === installationId && !!repo.indexRetryAfter && repo.indexRetryAfter.getTime() > Date.now();
}

export async function enqueuePendingRepositoryIndexes(organizationId: string, repositoryId?: string, providers?: string[]) {
  const eligibleProviders = ["github", "forgejo"].filter(provider => !providers || providers.includes(provider));
  if (!eligibleProviders.length) return;
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { githubInstallationId: true } });
  if (!org) return;
  const repos = await prisma.repository.findMany({
    where: {
      organizationId,
      ...(repositoryId ? { id: repositoryId } : {}),
      provider: { in: eligibleProviders },
      isActive: true,
      dismissedAt: null,
      organization: { deletedAt: null, bannedAt: null, autoDiscoverRepos: true },
      ...needsIndex(new Date(), org.githubInstallationId),
    },
    select: { id: true },
    orderBy: { indexedAt: { sort: "asc", nulls: "first" } },
    take: 200,
  });
  for (const repo of repos) {
    await enqueue("index-repository", { repositoryId: repo.id, organizationId }, {
      singletonKey: repo.id,
      singletonSeconds: 60,
    });
  }
}

export async function processRepositoryIndex(job: RepositoryIndexJob, retry?: RetryState) {
  if (!job || typeof job.repositoryId !== "string" || !job.repositoryId ||
      typeof job.organizationId !== "string" || !job.organizationId) {
    throw new Error("Repository indexing requires repositoryId and organizationId");
  }
  // Recheck ownership and standing when the job runs: the installation may
  // have been disconnected, or the repository dismissed, while it was queued.
  const repo = await prisma.repository.findFirst({
    where: {
      id: job.repositoryId,
      organizationId: job.organizationId,
      provider: { in: ["github", "forgejo"] },
      isActive: true,
      dismissedAt: null,
      organization: { deletedAt: null, bannedAt: null, autoDiscoverRepos: true },
    },
    include: { organization: { select: { githubInstallationId: true } } },
  });
  const installationId = repo?.organization.githubInstallationId;
  if (!repo || (repo.provider === "github" && (!installationId || (repo.installationId && repo.installationId !== installationId)))) return;

  // Share the reviewer's claim so a first PR and discovery cannot both index.
  const indexAttemptId = randomUUID();
  const claim = await prisma.repository.updateMany({
    where: { id: repo.id, organizationId: job.organizationId, provider: repo.provider,
      isActive: true, dismissedAt: null, installationId: repo.installationId,
      organization: { deletedAt: null, bannedAt: null, autoDiscoverRepos: true,
        ...(repo.provider === "github" ? { githubInstallationId: installationId } : {}) },
      ...needsIndex(new Date(), installationId ?? null) },
    data: { indexStatus: "indexing", indexAttemptId },
  });
  if (!claim.count) {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM repositories WHERE id = ${repo.id} AND "organizationId" = ${job.organizationId} FOR UPDATE`;
      const current = await tx.repository.findFirst({
        where: { id: repo.id, organizationId: job.organizationId, provider: { in: ["github", "forgejo"] },
          isActive: true, dismissedAt: null, organization: { deletedAt: null, bannedAt: null, autoDiscoverRepos: true } },
        select: { provider: true, installationId: true, indexStatus: true, indexRetryAfter: true, indexRetryInstallationId: true,
          organization: { select: { githubInstallationId: true } } },
      });
      if (current && (!current.installationId || current.installationId === current.organization.githubInstallationId) &&
          treeRetryDeferred(current, current.organization.githubInstallationId)) throw new GitHubTreeRestrictedError();
    });
    return;
  }

  const controller = createAbortController(indexAttemptId);
  // Abort before pg-boss expires the attempt, so the catch can release its claim.
  const deadlineError = new DOMException("Repository indexing timed out", "TimeoutError");
  const timeout = setTimeout(() => controller.abort(deadlineError), 25 * 60_000);
  const channel = `presence-org-${job.organizationId}`;
  const log = (message: string, level: LogLevel = "info") => {
    writeSyncLog({ orgId: job.organizationId, repoId: repo.id, message, level, timestamp: Date.now() });
  };
  try {
    const stats = await runRepositoryIndex(repo.id, indexAttemptId, async () => {
      const { indexRepository } = await import("@/lib/indexer");
      await deleteSyncLogs(job.organizationId, repo.id);
      void notifyRepositoryIndex(channel, repo.id);
      return indexRepository(
        { repoId: repo.id, indexAttemptId }, repo.fullName, repo.defaultBranch, installationId ?? 0, log,
        controller.signal, repo.provider, job.organizationId,
      );
    }, controller.signal, { installationId: repo.provider === "github" ? installationId ?? undefined : undefined });
    log(`Indexing complete: ${stats.indexedFiles} files, ${stats.totalVectors} vectors`, "success");
    void notifyRepositoryIndex(channel, repo.id);
  } catch (error) {
    if (error instanceof SupersededIndexError) return;
    const isCancelled = isIndexingCancelled(controller.signal);
    log(`Indexing failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    if (!controller.signal.aborted && error instanceof GitHubTreeRestrictedError) log(TREE_RESTRICTION_MESSAGE, "warning");
    void notifyRepositoryIndex(channel, repo.id);
    if (!isCancelled) {
      reportBackgroundFailure(error, { stage: "indexing", attemptId: indexAttemptId, repositoryId: repo.id, retry,
        indexingDeadline: error === deadlineError && controller.signal.reason === deadlineError });
      throw error;
    }
  } finally {
    clearTimeout(timeout);
    clearAbortController(indexAttemptId);
  }
}
