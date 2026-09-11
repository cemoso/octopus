import { expect, it } from "bun:test";

it("keeps one summary through review phases and fences stale publication", async () => {
  const child = Bun.spawn(["bun", "lib/__tests__/fixtures/review-summary-comment-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("PASS stable summary, history, stale fencing, concurrency and failure handling");
});
