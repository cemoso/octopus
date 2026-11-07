import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

(process.env.RUN_FIRST_INDEX_DB_TESTS === "1" ? describe : describe.skip)("review cooldown with PostgreSQL", () => {
  it("finishes the GitHub check and explains review recovery", async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/reviewer-cooldown-db.ts", import.meta.url))], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
  }, 30_000);
});
