import "server-only";
import { prisma, type Prisma } from "@octopus/db";
import { auth } from "@/lib/auth";
import { authenticateApiToken } from "@/lib/api-auth";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let organization: Prisma.OrganizationWhereInput;
  if (request.headers.has("authorization")) {
    const access = await authenticateApiToken(request);
    if (access instanceof Response) return access;
    if (!access) return Response.json({ error: "Unauthorized" }, { status: 401 });
    organization = { id: access.org.id, bannedAt: null, deletedAt: null };
  } else {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    organization = { bannedAt: null, deletedAt: null, members: { some: { userId: session.user.id, deletedAt: null } } };
  }
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return Response.json({ error: "Review attempt not found" }, { status: 404 });
  }
  const attempt = await prisma.reviewAttempt.findFirst({
    where: { id, pullRequest: { repository: { organization, isActive: true } } },
    select: { id: true, headSha: true, baseSha: true, coverage: true, reviewBody: true, createdAt: true },
  });
  if (!attempt) return Response.json({ error: "Review attempt not found" }, { status: 404 });
  return Response.json(attempt, { headers: {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `attachment; filename="review-attempt-${id}.json"`,
  } });
}
