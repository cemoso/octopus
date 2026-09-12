import "server-only";
import { prisma } from "@octopus/db";
import { createHash, createHmac, randomBytes } from "node:crypto";

export const CLI_USER_TOKEN_PREFIX = "oct_u_";
export const hashCliToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const generateCliUserToken = () => `${CLI_USER_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;

/** This credential authenticates a person, never an organisation API request. */
export async function authenticateCliUser(request: Request) {
  const header = request.headers.get("authorization");
  const raw = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!/^oct_u_[a-f0-9]{64}$/.test(raw)) return null;
  const token = await prisma.cliUserToken.findUnique({
    where: { tokenHash: hashCliToken(raw) },
    include: { user: true },
  });
  if (!token || token.deletedAt || token.expiresAt <= new Date() || token.user.bannedAt) return null;
  return { token, user: token.user, raw };
}

/** Derive a stable child secret so org selection does not mint unbounded tokens. */
export function deriveCliOrgToken(userToken: string, orgId: string): string {
  return `oct_${createHmac("sha256", userToken).update(`octopus-cli-org-v1:${orgId}`).digest("hex")}`;
}
