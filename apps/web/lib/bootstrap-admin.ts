import "server-only";
import { prisma } from "@octopus/db";
import { auth } from "./auth";

/**
 * Boot-time seed: if the database has no users at all, create a default
 * admin account. The user is flagged `mustChangePassword=true` so the
 * very first sign-in lands on `/change-password` and they cannot reach
 * any other page (or any /api/* endpoint) until they pick a real password.
 *
 * Idempotent — runs on every server boot but is a no-op once at least
 * one user exists. Skipped entirely when `DISABLE_ADMIN_SEED=true` for
 * operators who provision users out-of-band.
 *
 * Why this is safe despite shipping a default credential:
 *   1. Only seeded on a *truly empty* user table — never overwrites
 *      an existing account, never resets a real user's password.
 *   2. The mustChangePassword flag is enforced at middleware.ts for
 *      every authenticated request (UI redirect + API 403), so the
 *      seeded credential can only ever reach the change-password page
 *      and the password-changed POST endpoint.
 *   3. Wiped automatically when the user picks a new password via
 *      /api/me/password-changed (see route handler).
 */
// admin@example.com — example.com is a reserved domain (RFC 2606) that
// always passes email validation and never collides with a real inbox.
// The password is intentionally an obvious placeholder; the mustChangePassword
// flag forces a real choice on first sign-in, so this string can never
// actually be used to access any UI beyond /change-password.
const DEFAULT_ADMIN_EMAIL = "admin@example.com";
const DEFAULT_ADMIN_PASSWORD = "change-me-now";
const DEFAULT_ADMIN_NAME = "Admin";

/**
 * Probe whether the seeded admin account still has the default password —
 * the only safe trigger for the self-heal in {@link bootstrapDefaultAdmin}.
 *
 * Implementation: try `auth.api.signInEmail` with the default credential.
 * Success = the stored hash still matches; failure (BAD_REQUEST / 401) =
 * the password has been changed (or the account was reconfigured) and we
 * should NOT touch the flag. Side-effect: this creates a session row. We
 * delete it immediately after — it never reaches a real client.
 *
 * Throws are caught and treated as "do not self-heal" so a probe outage
 * doesn't trigger an unwanted force-reset.
 */
async function isPasswordStillDefault(): Promise<boolean> {
  try {
    const result = await auth.api.signInEmail({
      body: { email: DEFAULT_ADMIN_EMAIL, password: DEFAULT_ADMIN_PASSWORD },
    });
    const sessionToken = result?.token;
    if (sessionToken) {
      await prisma.session.deleteMany({ where: { token: sessionToken } });
    }
    return Boolean(result?.user);
  } catch {
    return false;
  }
}

let bootstrapPromise: Promise<void> | null = null;

export async function bootstrapDefaultAdmin(): Promise<void> {
  if (process.env.DISABLE_ADMIN_SEED === "true") return;
  // Guard against multiple concurrent invocations during dev hot-reloads.
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    const userCount = await prisma.user.count();
    if (userCount > 0) {
      // Self-heal: handle the rare case where the very first boot crashed
      // *between* signUpEmail and the post-signup mustChangePassword update.
      // The naive form ("re-flag if the sole user is admin@example.com")
      // re-runs every boot AFTER the admin legitimately changed their
      // password — same email, flag now false → infinite loop of forced
      // password changes on every restart.
      //
      // The right gate is: re-flag only if the stored credential is STILL
      // the seeded default. We verify that via Better Auth's API: a
      // signInEmail call with the default password succeeds iff the hash
      // still matches the default, which means the user never completed
      // the forced change. Any other state (real password set, account
      // disabled, deleted) falls through and the flag is left alone.
      if (userCount === 1) {
        const sole = await prisma.user.findFirst({
          where: { email: DEFAULT_ADMIN_EMAIL, mustChangePassword: false },
          select: { id: true },
        });
        if (sole) {
          const stillUsingDefault = await isPasswordStillDefault();
          if (stillUsingDefault) {
            await prisma.user.update({
              where: { id: sole.id },
              data: { mustChangePassword: true },
            });
            console.log(
              `[bootstrap-admin] patched ${DEFAULT_ADMIN_EMAIL}: mustChangePassword=true (default password still in use)`,
            );
          }
        }
      }
      return;
    }

    try {
      // Use Better Auth's signUp.email so the password is hashed with the
      // same algorithm the sign-in flow uses to verify. Going through the
      // server API instead of prisma directly also keeps the `accounts`
      // row (where Better Auth stores the credential hash) in sync.
      const result = await auth.api.signUpEmail({
        body: {
          email: DEFAULT_ADMIN_EMAIL,
          password: DEFAULT_ADMIN_PASSWORD,
          name: DEFAULT_ADMIN_NAME,
        },
      });
      const userId = result.user?.id;
      if (!userId) {
        console.error("[bootstrap-admin] signUpEmail returned no user id");
        return;
      }
      await prisma.user.update({
        where: { id: userId },
        data: { mustChangePassword: true, emailVerified: true },
      });
      console.log(
        "[bootstrap-admin] ╔════════════════════════════════════════════════════╗",
      );
      console.log(
        `[bootstrap-admin] ║ First-boot admin account created:                  ║`,
      );
      console.log(
        `[bootstrap-admin] ║   email:    ${DEFAULT_ADMIN_EMAIL.padEnd(38)} ║`,
      );
      console.log(
        `[bootstrap-admin] ║   password: ${DEFAULT_ADMIN_PASSWORD.padEnd(38)} ║`,
      );
      console.log(
        "[bootstrap-admin] ║ You will be forced to change the password on the   ║",
      );
      console.log(
        "[bootstrap-admin] ║ first sign-in. Set DISABLE_ADMIN_SEED=true to skip ║",
      );
      console.log(
        "[bootstrap-admin] ║ this on future fresh installs.                     ║",
      );
      console.log(
        "[bootstrap-admin] ╚════════════════════════════════════════════════════╝",
      );
    } catch (err) {
      // Don't fail boot if the seed errors (e.g. concurrent boots racing
      // the unique constraint). Log and move on; the operator can sign up
      // manually if needed.
      console.error(
        "[bootstrap-admin] failed to seed default admin:",
        err instanceof Error ? err.message : String(err),
      );
    }
  })();

  return bootstrapPromise;
}
