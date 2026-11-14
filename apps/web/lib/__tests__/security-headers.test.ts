import { afterEach, expect, it } from "bun:test";
import nextConfig from "../../next.config";

// Asks the real Next config which response headers it sets, as Next does at build time.
const original = process.env.NEXT_PUBLIC_OCTOPUS_SELF_HOSTED;
afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_OCTOPUS_SELF_HOSTED;
  else process.env.NEXT_PUBLIC_OCTOPUS_SELF_HOSTED = original;
});

async function headerRules() {
  const config = typeof nextConfig === "function" ? await nextConfig("phase-production-build", { defaultConfig: {} }) : nextConfig;
  return (await config.headers?.()) ?? [];
}

it("tells browsers to keep using HTTPS on every page of the cloud site", async () => {
  delete process.env.NEXT_PUBLIC_OCTOPUS_SELF_HOSTED;
  const rules = await headerRules();
  const hsts = rules.flatMap((rule) => rule.headers.map((header) => ({ source: rule.source, ...header }))).filter((header) => header.key === "Strict-Transport-Security");
  expect(hsts).toEqual([{ source: "/:path*", key: "Strict-Transport-Security", value: "max-age=31536000" }]);
});

it("leaves that choice to a self-hosted install", async () => {
  process.env.NEXT_PUBLIC_OCTOPUS_SELF_HOSTED = "true";
  const rules = await headerRules();
  expect(rules.flatMap((rule) => rule.headers).filter((header) => header.key === "Strict-Transport-Security")).toEqual([]);
});
