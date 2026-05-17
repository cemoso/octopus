import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@octopus/db";
import { LocalAgentTable } from "./local-agent-table";

/**
 * Local Agent settings.
 *
 * Lists every registered LocalAgent for the org with status, capabilities,
 * machine info, and a revoke action. Also shows the install one-liner so
 * a new agent can be spun up without leaving the page.
 *
 * The agent itself ships in `apps/cli/` (`octp agent serve`) — see PR #91.
 * Background on what a local agent does: PR #90 + the bridge dispatch in
 * the `local` provider.
 */
export default async function LocalAgentSettingsPage() {
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
    select: { organizationId: true, role: true },
  });
  if (!member) redirect("/dashboard");

  const orgId = member.organizationId;

  // Mark agents offline if they haven't heartbeated in 90 seconds.
  // Best-effort — the heartbeat endpoint also sets status on its end.
  const staleCutoff = new Date(Date.now() - 90 * 1000);
  await prisma.localAgent.updateMany({
    where: { organizationId: orgId, status: "online", lastSeenAt: { lt: staleCutoff } },
    data: { status: "offline" },
  });

  const agents = await prisma.localAgent.findMany({
    where: { organizationId: orgId },
    orderBy: [{ status: "asc" }, { lastSeenAt: "desc" }],
    select: {
      id: true,
      name: true,
      status: true,
      lastSeenAt: true,
      capabilities: true,
      machineInfo: true,
      createdAt: true,
    },
  });

  // Active API tokens — needed for the install one-liner. We only show count;
  // the user copies an existing token from /settings/api-tokens.
  const tokenCount = await prisma.orgApiToken.count({
    where: { organizationId: orgId },
  });

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-white">Local Agent</h1>
        <p className="mt-1 text-sm text-[#888]">
          Run reviews through a model installed on your laptop (Ollama, Claude
          Code subscription, etc.) instead of a hosted provider. Useful for
          local-first development, no-cost runs, or when you can&apos;t share
          code with a cloud API.
        </p>
      </div>

      <section className="mb-8 rounded border border-[#222] p-4">
        <h2 className="mb-2 text-sm font-semibold text-white">How it works</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-[#888]">
          <li>Install <code>octp</code> via the curl/irm one-liner (<a href="/docs/cli" className="text-cyan-400 underline">docs</a>).</li>
          <li>Create an API token at <a href="/settings/api-tokens" className="text-cyan-400 underline">Settings → Auth Tokens</a> ({tokenCount} active).</li>
          <li>Start the agent: <code className="rounded bg-[#0a0a0a] px-1.5 py-0.5">octp agent serve</code></li>
          <li>Set a repo&apos;s review model to <code>local:&lt;model-id&gt;</code> at <a href="/settings/models" className="text-cyan-400 underline">Models</a>.</li>
          <li>Open a PR — Octopus routes the review through your machine.</li>
        </ol>
      </section>

      <h2 className="mb-3 text-sm font-semibold text-white">Registered agents</h2>
      <LocalAgentTable
        agents={agents.map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
          capabilities: (a.capabilities as string[]) ?? [],
          machineInfo: a.machineInfo as Record<string, string> | null,
          createdAt: a.createdAt.toISOString(),
        }))}
        canRevoke={member.role === "owner" || member.role === "admin"}
      />
    </div>
  );
}
