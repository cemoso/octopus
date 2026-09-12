import "server-only";
import { prisma } from "@octopus/db";
import { authenticateCliUser } from "@/lib/cli-user-auth";

export async function GET(request: Request) {
  const identity = await authenticateCliUser(request);
  if (!identity) return Response.json({ error: "Invalid or expired CLI session." }, { status: 401 });
  return Response.json({ user: { name: identity.user.name, email: identity.user.email } }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: Request) {
  const identity = await authenticateCliUser(request);
  if (!identity) return Response.json({ error: "Invalid or expired CLI session." }, { status: 401 });
  await prisma.cliUserToken.update({ where: { id: identity.token.id }, data: { deletedAt: new Date() } });
  return Response.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
