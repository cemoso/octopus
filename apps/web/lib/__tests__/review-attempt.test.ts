import { expect, it } from "bun:test";

it("preserves earlier attempts and enforces access at the actual HTTP handler", async () => {
  // Isolate module mocks from the rest of the review/provider suite.
  const process = Bun.spawn(["bun", "lib/__tests__/fixtures/review-attempt-harness.ts"], { cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("PASS stale-head isolation, immutable attempts");
});
