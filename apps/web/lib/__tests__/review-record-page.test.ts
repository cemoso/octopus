import { expect, it } from "bun:test";

it("renders immutable review history and enforces membership at the page loader", async () => {
  const process = Bun.spawn(["bun", "lib/__tests__/fixtures/review-record-page-harness.tsx"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("PASS protected readable review history");
});
