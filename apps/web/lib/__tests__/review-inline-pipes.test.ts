import { expect, it } from "bun:test";

it("publishes inline pipe prose without changing rendered text or stored assessment", async () => {
  const child = Bun.spawn(["bun", "lib/__tests__/fixtures/review-inline-pipes-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("PASS actual POST/PATCH keeps rendered pipe text, score and immutable records");
});
