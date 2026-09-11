import { expect, it } from "bun:test";

it("requires completed responses and binds immutable results to actual adapter requests", async () => {
  const child = Bun.spawn(["bun", "lib/__tests__/fixtures/review-assessment-harness.ts"], { cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("PASS adapter completion, publication and immutable request identity");
});
