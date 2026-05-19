import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma, type Prisma } from "@octopus/db";

/**
 * Admin view of `octp review` activity. Pulls from the `cli.review_local`
 * audit-log entries written by both /api/cli/review-local (bare mode)
 * and /api/cli/repos/[id]/local-review (with-context mode).
 *
 * Goal: give a self-hosted operator visibility into what the CLI is
 * actually being used for — who's running pre-PR reviews, against what,
 * how big the diffs are, which models they're choosing. Useful for
 * spotting abuse, sizing infra, or just seeing the team's adoption.
 *
 * Server-rendered; no client-side fetch since the data volume is
 * modest (one row per CLI review, retained for the same N days as the
 * rest of the audit log). Last 100 entries by default — extend with a
 * cursor + pagination if usage grows.
 */
export default async function CliUsagePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  const cookieStore = await cookies();
  const currentOrgId = cookieStore.get("current_org_id")?.value;

  const member = await prisma.organizationMember.findFirst({
    where: {
      userId: session.user.id,
      ...(currentOrgId ? { organizationId: currentOrgId } : {}),
      deletedAt: null,
    },
    select: { role: true, organizationId: true },
  });
  if (!member) redirect("/dashboard");
  if (member.role !== "owner" && member.role !== "admin") redirect("/settings");

  const entries = await prisma.auditLog.findMany({
    where: {
      organizationId: member.organizationId,
      action: "cli.review_local",
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
    select: {
      id: true,
      actorEmail: true,
      createdAt: true,
      metadata: true,
      ipAddress: true,
    },
  });

  // Per-user roll-up for the top-of-page summary block.
  const byUser = new Map<string, { runs: number; findings: number; bytes: number }>();
  for (const e of entries) {
    const m = parseMetadata(e.metadata);
    const key = e.actorEmail ?? "(unknown)";
    const cur = byUser.get(key) ?? { runs: 0, findings: 0, bytes: 0 };
    cur.runs += 1;
    cur.findings += m.findingCount;
    cur.bytes += m.diffBytes;
    byUser.set(key, cur);
  }
  const topUsers = Array.from(byUser.entries())
    .sort((a, b) => b[1].runs - a[1].runs)
    .slice(0, 5);

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-white">CLI Activity</h1>
        <p className="mt-1 text-sm text-[#888]">
          Pre-PR reviews run via <code className="rounded bg-[#1a1a1a] px-1 text-[12px]">octp review</code>{" "}
          on developer machines. The cloud PR review still gates merges; this is the local-feedback channel.
        </p>
      </div>

      {/* Top contributors */}
      {topUsers.length > 0 ? (
        <section className="mb-8 rounded border border-[#222] p-4">
          <h2 className="mb-3 text-sm font-semibold text-white">Top users (last {entries.length} runs)</h2>
          <div className="space-y-1.5 text-sm">
            {topUsers.map(([email, stats]) => (
              <div key={email} className="flex items-baseline gap-3">
                <span className="w-64 truncate font-mono text-[#ccc]">{email}</span>
                <span className="text-[#888]">{stats.runs} run{stats.runs === 1 ? "" : "s"}</span>
                <span className="text-[#666]">·</span>
                <span className="text-[#888]">{stats.findings} findings</span>
                <span className="text-[#666]">·</span>
                <span className="text-[#888]">{(stats.bytes / 1024).toFixed(0)} KB total diff</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <h2 className="mb-3 text-sm font-semibold text-white">Recent runs</h2>
      {entries.length === 0 ? (
        <div className="rounded border border-[#222] p-6 text-center text-sm text-[#888]">
          No CLI reviews yet. Install <code className="text-white">octp</code> and run{" "}
          <code className="text-white">octp review</code> in a repo to see activity here.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-[#222]">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#0a0a0a] text-[#888]">
              <tr>
                <th className="px-3 py-2 font-semibold">When</th>
                <th className="px-3 py-2 font-semibold">User</th>
                <th className="px-3 py-2 font-semibold">Mode</th>
                <th className="px-3 py-2 font-semibold">Repo / Title</th>
                <th className="px-3 py-2 font-semibold text-right">Diff</th>
                <th className="px-3 py-2 font-semibold text-right">Findings</th>
                <th className="px-3 py-2 font-semibold">Model</th>
                <th className="px-3 py-2 font-semibold">IP</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const m = parseMetadata(e.metadata);
                return (
                  <tr key={e.id} className="border-t border-[#191919] align-top text-[#ccc]">
                    <td className="whitespace-nowrap px-3 py-2 text-[#888]">
                      {new Date(e.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 font-mono">{e.actorEmail ?? "—"}</td>
                    <td className="px-3 py-2">
                      <ModePill mode={m.mode} />
                    </td>
                    <td className="px-3 py-2 text-[#888]">
                      {m.repoFullName ? (
                        <span className="font-mono text-[#ccc]">{m.repoFullName}</span>
                      ) : null}
                      {m.title ? <div className="text-[#666]">{m.title}</div> : null}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[#888]">
                      {(m.diffBytes / 1024).toFixed(1)} KB
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[#ccc]">{m.findingCount}</td>
                    <td className="px-3 py-2 font-mono text-[#888]">{m.model ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-[#666]">{e.ipAddress ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type ReviewMetadata = {
  mode: "bare" | "with-context" | "unknown";
  diffBytes: number;
  findingCount: number;
  model: string | null;
  repoFullName: string | null;
  title: string | null;
};

function parseMetadata(raw: Prisma.JsonValue | null): ReviewMetadata {
  const fallback: ReviewMetadata = {
    mode: "unknown",
    diffBytes: 0,
    findingCount: 0,
    model: null,
    repoFullName: null,
    title: null,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const obj = raw as Record<string, unknown>;
  return {
    mode:
      obj.mode === "bare" || obj.mode === "with-context"
        ? (obj.mode as ReviewMetadata["mode"])
        : "unknown",
    diffBytes: typeof obj.diffBytes === "number" ? obj.diffBytes : 0,
    findingCount: typeof obj.findingCount === "number" ? obj.findingCount : 0,
    model: typeof obj.model === "string" ? obj.model : null,
    repoFullName: typeof obj.repoFullName === "string" ? obj.repoFullName : null,
    title: typeof obj.title === "string" ? obj.title : null,
  };
}

function ModePill({ mode }: { mode: ReviewMetadata["mode"] }) {
  const color =
    mode === "with-context"
      ? "bg-cyan-950 text-cyan-300"
      : mode === "bare"
        ? "bg-[#1a1a1a] text-[#888]"
        : "bg-[#1a1a1a] text-[#666]";
  return <span className={`rounded px-2 py-0.5 text-[11px] ${color}`}>{mode}</span>;
}
