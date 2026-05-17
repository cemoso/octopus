import { prisma } from "@octopus/db";

const RELEASES_API = "https://api.github.com/repos/octopusreview/octopus/releases/latest";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

type CachedRelease = {
  tagName: string;
  htmlUrl: string;
  publishedAt: string;
  body: string;
  fetchedAt: string;
};

/**
 * GET /api/releases/latest
 *
 * Returns the cached latest release plus a comparison against the running
 * build's version. The self-hosted Updates page reads this. Cache lives in
 * SystemConfig.latestRelease, refreshed daily by the
 * "refresh-release-cache" pg-boss job. On a cache miss (the daily job
 * hasn't run yet) we fetch synchronously here and write through.
 *
 * Returns:
 *   {
 *     currentVersion: "0.1.0",
 *     latestVersion: "0.2.0" | null,
 *     isUpToDate: boolean,
 *     releaseUrl: string | null,
 *     releaseNotes: string | null,
 *     publishedAt: string | null,
 *     cachedAt: string | null,
 *   }
 */
export async function GET() {
  const currentVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";

  let cached = await readCache();
  if (!cached || isStale(cached)) {
    const fresh = await fetchLatest();
    if (fresh) {
      await writeCache(fresh);
      cached = fresh;
    }
  }

  if (!cached) {
    return Response.json({
      currentVersion,
      latestVersion: null,
      isUpToDate: false,
      releaseUrl: null,
      releaseNotes: null,
      publishedAt: null,
      cachedAt: null,
      error: "Could not check for updates. Try again later.",
    });
  }

  const latestVersion = cached.tagName.replace(/^v/, "");
  return Response.json({
    currentVersion,
    latestVersion,
    isUpToDate: compareSemver(currentVersion, latestVersion) >= 0,
    releaseUrl: cached.htmlUrl,
    releaseNotes: cached.body,
    publishedAt: cached.publishedAt,
    cachedAt: cached.fetchedAt,
  });
}

async function readCache(): Promise<CachedRelease | null> {
  const row = await prisma.systemConfig.findUnique({
    where: { id: "singleton" },
    select: { latestRelease: true },
  });
  if (!row?.latestRelease) return null;
  return row.latestRelease as unknown as CachedRelease;
}

function isStale(cached: CachedRelease): boolean {
  const ts = new Date(cached.fetchedAt).getTime();
  return Number.isNaN(ts) || Date.now() - ts > CACHE_TTL_MS;
}

async function writeCache(value: CachedRelease): Promise<void> {
  await prisma.systemConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", latestRelease: value as unknown as object },
    update: { latestRelease: value as unknown as object },
  });
}

export async function fetchLatest(): Promise<CachedRelease | null> {
  try {
    const r = await fetch(RELEASES_API, {
      headers: { accept: "application/vnd.github+json", "user-agent": "octopus-self-hosted-update-check" },
    });
    if (!r.ok) {
      console.warn(`[releases] GitHub Releases API returned ${r.status}`);
      return null;
    }
    const body = (await r.json()) as {
      tag_name?: string;
      html_url?: string;
      published_at?: string;
      body?: string;
    };
    if (!body.tag_name || !body.html_url || !body.published_at) return null;
    return {
      tagName: body.tag_name,
      htmlUrl: body.html_url,
      publishedAt: body.published_at,
      body: body.body ?? "",
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.warn("[releases] GitHub fetch failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * Tiny semver compare. Returns -1 if a<b, 0 if equal, 1 if a>b. Ignores
 * pre-release / build metadata (good enough for "is this version current?").
 */
export function compareSemver(a: string, b: string): number {
  const aParts = a.split(/[-+]/)[0].split(".").map((n) => parseInt(n, 10) || 0);
  const bParts = b.split(/[-+]/)[0].split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const ax = aParts[i] ?? 0;
    const bx = bParts[i] ?? 0;
    if (ax !== bx) return ax < bx ? -1 : 1;
  }
  return 0;
}
