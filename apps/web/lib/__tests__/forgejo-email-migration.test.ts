import { expect, it } from "bun:test";
import { SQL } from "bun";
import { readFileSync } from "node:fs";

const databaseUrl = process.env.FORGEJO_EMAIL_TEST_DATABASE_URL;

// Run against a disposable PostgreSQL database; a temporary table shadows any
// real email table, and is dropped at the end of the transaction.
it.skipIf(!databaseUrl)("updates default Forgejo emails without changing custom content or delivery settings", async () => {
  expect(new URL(databaseUrl!).pathname).toMatch(/test/i);
  const sql = new SQL(databaseUrl!);
  const migration = readFileSync(new URL("../../../../packages/db/prisma/migrations/20260919153000_forgejo_email_templates/migration.sql", import.meta.url), "utf8");
  const seeds = readFileSync(new URL("../email-template-seeds.ts", import.meta.url), "utf8");
  const updates = [...migration.matchAll(/SET "body" = \$forgejo_template\$([\s\S]*?)\$forgejo_template\$,[\s\S]*?WHERE "slug" = '([^']+)'[\s\S]*?"body" = \$forgejo_template\$([\s\S]*?)\$forgejo_template\$/g)];
  expect(updates).toHaveLength(3);

  try {
    await sql.begin(async (tx) => {
      await tx`CREATE TEMP TABLE email_templates (
        id text, slug text, body text, system boolean, enabled boolean,
        subject text DEFAULT 'Custom subject', "fromEmail" text DEFAULT 'custom@example.test',
        "updatedAt" timestamp DEFAULT CURRENT_TIMESTAMP
      ) ON COMMIT DROP`;
      for (const [, nextBody, slug, oldBody] of updates) {
        expect(seeds).toContain(`body: \`${nextBody}\``);
        for (const variant of ["default", "custom", "non-system", "disabled"]) {
          const body = variant === "custom" ? `${oldBody}\nPersonal note` : oldBody;
          await tx`INSERT INTO email_templates (id, slug, body, system, enabled)
            VALUES (${`${slug}:${variant}`}, ${slug}, ${body}, ${variant !== "non-system"}, ${variant !== "disabled"})`;
        }
      }
      // Running twice also checks that the migration is safe to retry.
      await tx.unsafe(migration).simple();
      await tx.unsafe(migration).simple();
      for (const [, nextBody, slug, oldBody] of updates) {
        const rows = await tx`SELECT * FROM email_templates WHERE slug = ${slug}`;
        for (const row of rows) {
          const variant = row.id.split(":")[1];
          const expectedBody = variant === "custom" ? `${oldBody}\nPersonal note`
            : variant === "non-system" ? oldBody : nextBody;
          expect(row.body).toBe(expectedBody);
          expect(row.enabled).toBe(variant !== "disabled");
          expect(row.subject).toBe("Custom subject");
          expect(row.fromEmail).toBe("custom@example.test");
        }
      }
    });
  } finally {
    await sql.close();
  }
});
