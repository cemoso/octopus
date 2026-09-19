import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { mock } from "bun:test";
import { prisma } from "@octopus/db";
import { encryptJson, decryptJson } from "@/lib/crypto";

mock.module("server-only", () => ({}));
const userId = randomUUID();
let currentOrganization = "";
mock.module("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => ({ value: currentOrganization }) }) }));
mock.module("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); } }));
mock.module("next/cache", () => ({ revalidatePath: () => {} }));
mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => ({ user: { id: userId } }) } } }));
mock.module("@/lib/repo-sync", () => ({ syncForgejoRepos: async () => ({ synced: 0 }) }));
const { createConnectorToken, hashConnectorToken, pollForgejoConnector, completeForgejoConnector,
  requestViaForgejoConnector, cleanupForgejoConnectorRequests, ForgejoConnectorUncertainError } = await import("@/lib/forgejo-connector");

const host = "https://forgejo.private.example";
const token = createConnectorToken();
const hash = hashConnectorToken(token);
const token2 = createConnectorToken();
const organizations: string[] = [];
const request = (body: unknown, credential = token) => new Request("https://octopus.example/api/forgejo/connector/poll", {
  method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify(body),
});
const poll = (credential = token, extra: Record<string, unknown> = {}) => pollForgejoConnector(request({ host, username: "review-bot", ...extra }, credential));
const completed = (command: { id: string; leaseToken: string }, body = '{"id":1}', credential = token) =>
  completeForgejoConnector(request({ id: command.id, leaseToken: command.leaseToken, result: { body, headers: {} } }, credential));
const until = async (predicate: () => Promise<boolean>) => {
  for (let i = 0; i < 150; i++) { if (await predicate()) return; await Bun.sleep(20); }
  throw new Error("Timed out waiting for connector state");
};

async function checkMigration() {
  const schema = `connector_migration_${randomUUID().replaceAll("-", "")}`;
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query('CREATE TABLE forgejo_integrations (id TEXT PRIMARY KEY, "forgejoHost" TEXT NOT NULL, username TEXT NOT NULL, "accessTokenEnc" TEXT NOT NULL)');
    await client.query('INSERT INTO forgejo_integrations VALUES ($1,$2,$3,$4)', ["prior-direct", host, "prior-bot", "prior-ciphertext"]);
    const migration = await readFile(new URL("../../../../../packages/db/prisma/migrations/20260919160000_forgejo_private_connector/migration.sql", import.meta.url), "utf8");
    await client.query(migration);
    const existing = (await client.query('SELECT * FROM forgejo_integrations WHERE id=$1', ["prior-direct"])).rows[0];
    assert.deepEqual(existing, { id: "prior-direct", forgejoHost: host, username: "prior-bot", accessTokenEnc: "prior-ciphertext", connectorTokenHash: null, connectorLastSeenAt: null, connectorError: null });
    await assert.rejects(client.query('INSERT INTO forgejo_integrations (id,"forgejoHost",username) VALUES ($1,$2,$3)', ["no-transport", host, "bot"]), (error: unknown) => (error as { code?: string }).code === "23514");
    await assert.rejects(client.query('INSERT INTO forgejo_integrations (id,"forgejoHost",username,"accessTokenEnc","connectorTokenHash") VALUES ($1,$2,$3,$4,$5)', ["two-transports", host, "bot", "ciphertext", "token-hash"]), (error: unknown) => (error as { code?: string }).code === "23514");
    await client.query('INSERT INTO forgejo_integrations (id,"forgejoHost",username,"connectorTokenHash") VALUES ($1,$2,$3,$4)', ["connector", host, "bot", "unique-hash"]);
    await assert.rejects(client.query('INSERT INTO forgejo_integrations (id,"forgejoHost",username,"connectorTokenHash") VALUES ($1,$2,$3,$4)', ["duplicate", host, "bot", "unique-hash"]), (error: unknown) => (error as { code?: string }).code === "23505");
    await client.query('INSERT INTO forgejo_connector_requests (id,"integrationId",method,"requestEnc","expiresAt") VALUES ($1,$2,$3,$4,$5)', ["request", "connector", "GET", "ciphertext", new Date(Date.now() + 60_000)]);
    assert.equal((await client.query('SELECT status FROM forgejo_connector_requests WHERE id=$1', ["request"])).rows[0].status, "queued");
    await client.query('DELETE FROM forgejo_integrations WHERE id=$1', ["connector"]);
    assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM forgejo_connector_requests')).rows[0].count, 0);
    assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM forgejo_integrations')).rows[0].count, 1);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
}

try {
  await checkMigration();
  for (let i = 0; i < 2; i++) {
    const org = await prisma.organization.create({ data: { name: "Connector test", slug: `connector-test-${randomUUID()}` } });
    organizations.push(org.id);
  }
  currentOrganization = organizations[0];
  const integration = await prisma.forgejoIntegration.create({ data: {
    organizationId: organizations[0], forgejoHost: host, username: "", webhookSecret: randomUUID(), connectorTokenHash: hash,
  } });
  await prisma.forgejoIntegration.create({ data: {
    organizationId: organizations[1], forgejoHost: host, username: "", webhookSecret: randomUUID(), connectorTokenHash: hashConnectorToken(token2),
  } });
  const queued = (method = "GET", maxBytes = 1024) => prisma.forgejoConnectorRequest.create({ data: {
    integrationId: integration.id, method, expiresAt: new Date(Date.now() + 60_000), requestEnc: encryptJson({
      method, maxBytes, path: method === "GET" ? "/api/v1/user" : "/api/v1/repos/team/project/issues/1/comments",
      ...(method === "GET" ? {} : { body: { body: "Private review content" } }),
    }),
  } });
  const reset = async () => {
    await prisma.forgejoConnectorRequest.deleteMany({ where: { integrationId: integration.id } });
    await prisma.forgejoIntegration.update({ where: { id: integration.id }, data: { connectorError: null, connectorTokenHash: hash } });
  };

  assert.equal((await poll("invalid")).status, 401);
  assert.equal((await poll(token, { host: "https://other.example" })).status, 409);
  assert.equal((await poll(token, { username: "bad\u0000name" })).status, 400);
  assert.equal((await poll(token, { capacity: 5 })).status, 400);
  assert.equal((await poll(token, { capacity: 0 })).status, 200);
  assert.equal((await poll(token, { username: "different-bot" })).status, 409);
  const bound = await prisma.forgejoIntegration.findUniqueOrThrow({ where: { id: integration.id } });
  assert.equal(bound.username, "review-bot");
  assert.ok(bound.connectorLastSeenAt);
  assert.equal(bound.accessTokenEnc, null);
  assert.notEqual(bound.connectorTokenHash, token);
  await prisma.organization.update({ where: { id: organizations[0] }, data: { bannedAt: new Date() } });
  assert.equal((await poll()).status, 401);
  await prisma.organization.update({ where: { id: organizations[0] }, data: { bannedAt: null } });

  const jobs = await Promise.all(Array.from({ length: 8 }, () => queued()));
  assert.notEqual(jobs[0].requestEnc, JSON.stringify({ path: "/api/v1/user" }));
  const polls = await Promise.all([poll(), poll()]);
  const commands = (await Promise.all(polls.map(response => response.json()))).flatMap(result => result.commands);
  assert.equal(commands.length, 4);
  assert.equal(new Set(commands.map(command => command.id)).size, 4);
  assert.ok(commands.every(command => Date.parse(command.expiresAt) <= Date.now() + 20_000));
  assert.equal((await (await poll(token2)).json()).commands.length, 0);
  assert.equal((await completed(commands[0], undefined, token2)).status, 404);
  assert.equal((await completed({ ...commands[0], leaseToken: "b".repeat(64) })).status, 404);
  assert.equal((await completed(commands[0], "x".repeat(1025))).status, 413);
  assert.equal((await completed(commands[0])).status, 200);
  assert.equal((await completed(commands[0])).status, 200);
  assert.equal((await completed(commands[0], '{"id":2}')).status, 409);
  const stored = await prisma.forgejoConnectorRequest.findUniqueOrThrow({ where: { id: commands[0].id } });
  assert.equal(stored.requestEnc, "");
  assert.notEqual(stored.responseEnc, '{"id":1}');
  assert.deepEqual(decryptJson(stored.responseEnc!), { result: { body: '{"id":1}', headers: {} } });

  await reset();
  const read = requestViaForgejoConnector(integration.id, hash, "/api/v1/user");
  await until(async () => await prisma.forgejoConnectorRequest.count({ where: { integrationId: integration.id } }) === 1);
  const readCommand = (await (await poll()).json()).commands[0];
  assert.equal((await completed(readCommand, '{"login":"review-bot"}')).status, 200);
  assert.equal((await read).body, '{"login":"review-bot"}');
  assert.equal(await prisma.forgejoConnectorRequest.count({ where: { integrationId: integration.id } }), 0);

  await queued();
  const expired = (await (await poll()).json()).commands[0];
  await prisma.forgejoConnectorRequest.update({ where: { id: expired.id }, data: { leaseExpiresAt: new Date(Date.now() - 1) } });
  const reclaimed = (await (await poll()).json()).commands[0];
  assert.equal(reclaimed.id, expired.id);
  assert.notEqual(reclaimed.leaseToken, expired.leaseToken);
  assert.equal((await completed(expired)).status, 404);
  assert.equal((await completed(reclaimed)).status, 200);

  await reset();
  const revoked = requestViaForgejoConnector(integration.id, hash, "/api/v1/user").then(() => null, error => error);
  await until(async () => await prisma.forgejoConnectorRequest.count({ where: { integrationId: integration.id } }) === 1);
  const revokeCommand = (await (await poll()).json()).commands[0];
  await prisma.forgejoIntegration.update({ where: { id: integration.id }, data: { connectorTokenHash: hashConnectorToken(createConnectorToken()) } });
  assert.equal((await completed(revokeCommand)).status, 401);
  assert.match((await revoked).message, /no longer available/);

  await reset();
  const write = await queued("POST");
  const writeCommand = (await (await poll()).json()).commands[0];
  await prisma.forgejoConnectorRequest.update({ where: { id: write.id }, data: { leaseExpiresAt: new Date(Date.now() - 1) } });
  await assert.rejects(requestViaForgejoConnector(integration.id, hash, "/api/v1/user"), ForgejoConnectorUncertainError);
  assert.equal((await poll()).status, 409);
  assert.equal((await completed(writeCommand)).status, 409);
  assert.equal((await prisma.forgejoConnectorRequest.findUniqueOrThrow({ where: { id: write.id } })).status, "uncertain");
  await assert.rejects(requestViaForgejoConnector(integration.id, hash, "/api/v1/user"), ForgejoConnectorUncertainError);
  // Rotation must not silently clear an uncertain-write hold.
  await prisma.forgejoIntegration.update({ where: { id: integration.id }, data: { connectorTokenHash: hash } });
  assert.equal((await poll()).status, 409);

  await reset();
  await queued("POST");
  const unconsumed = (await (await poll()).json()).commands[0];
  assert.equal((await completed(unconsumed)).status, 200);
  await prisma.forgejoConnectorRequest.update({ where: { id: unconsumed.id }, data: { expiresAt: new Date(Date.now() - 1) } });
  // A worker crash after receiving the result but before consuming it must
  // never make the next review attempt blindly repeat that publication.
  assert.equal((await poll()).status, 409);

  await reset();
  const cancelled = new AbortController();
  const cancelledWrite = requestViaForgejoConnector(integration.id, hash, "/api/v1/repos/team/project/issues/1/comments", {
    method: "POST", body: { body: "test" }, signal: cancelled.signal,
  }).then(() => null, error => error);
  await until(async () => await prisma.forgejoConnectorRequest.count({ where: { integrationId: integration.id } }) === 1);
  assert.equal((await (await poll()).json()).commands.length, 1);
  cancelled.abort();
  assert.ok(await cancelledWrite instanceof ForgejoConnectorUncertainError);
  assert.equal((await poll()).status, 409);

  await reset();
  const unclaimedAbort = new AbortController();
  const unclaimed = requestViaForgejoConnector(integration.id, hash, "/api/v1/repos/team/project/issues/1/comments", {
    method: "POST", body: { body: "test" }, signal: unclaimedAbort.signal,
  }).then(() => null, error => error);
  await until(async () => await prisma.forgejoConnectorRequest.count({ where: { integrationId: integration.id } }) === 1);
  unclaimedAbort.abort();
  assert.ok(await unclaimed instanceof Error);
  assert.equal((await poll()).status, 200);
  assert.equal(await prisma.forgejoConnectorRequest.count({ where: { integrationId: integration.id } }), 0);

  await reset();
  await queued("POST");
  const failedCommand = (await (await poll()).json()).commands[0];
  assert.equal((await completeForgejoConnector(request({ id: failedCommand.id, leaseToken: failedCommand.leaseToken, error: "failed" }))).status, 200);
  assert.equal((await poll()).status, 409);

  await reset();
  await Promise.all(Array.from({ length: 64 }, () => queued()));
  await assert.rejects(requestViaForgejoConnector(integration.id, hash, "/api/v1/user"), /busy/);
  assert.equal(await prisma.forgejoConnectorRequest.count({ where: { integrationId: integration.id } }), 64);
  await prisma.forgejoConnectorRequest.updateMany({ where: { integrationId: integration.id }, data: { expiresAt: new Date(Date.now() - 1) } });
  await cleanupForgejoConnectorRequests();
  assert.equal(await prisma.forgejoConnectorRequest.count({ where: { integrationId: integration.id } }), 0);

  // Exercise the actual server actions with real membership rows and locks.
  const actions = await import("@/app/(app)/settings/integrations/actions");
  const form = new FormData(); form.set("host", "https://10.20.30.40");
  assert.equal((await actions.createForgejoConnector(form)).error, "Insufficient permissions.");
  await prisma.user.create({ data: { id: userId, email: `connector-${userId}@example.invalid`, name: "Connector test" } });
  const membership = await prisma.organizationMember.create({ data: { organizationId: organizations[0], userId, role: "member" } });
  assert.equal((await actions.createForgejoConnector(form)).error, "Insufficient permissions.");
  assert.equal((await actions.rotateForgejoConnector(integration.id)).error, "Insufficient permissions.");
  assert.equal((await actions.resumeForgejoConnector(integration.id)).error, "Insufficient permissions.");
  await prisma.organizationMember.update({ where: { id: membership.id }, data: { role: "owner" } });
  await prisma.forgejoIntegration.delete({ where: { id: integration.id } });
  const created = await actions.createForgejoConnector(form);
  assert.match(created.connectorToken!, /^ofc_[a-f0-9]{64}$/);
  const actionIntegration = await prisma.forgejoIntegration.findUniqueOrThrow({ where: { organizationId: organizations[0] } });
  assert.equal(actionIntegration.connectorTokenHash, hashConnectorToken(created.connectorToken!));
  assert.equal(actionIntegration.accessTokenEnc, null);
  // Private network setup stores an origin; it must never enable Cloud egress.
  const { normalizeForgejoHost } = await import("@/lib/forgejo-http");
  process.env.FORGEJO_ALLOWED_PRIVATE_ORIGINS = "https://10.20.30.40";
  process.env.OCTOPUS_SELF_HOSTED = "false";
  process.env.NEXT_PUBLIC_OCTOPUS_SELF_HOSTED = "false";
  assert.throws(() => normalizeForgejoHost("https://10.20.30.40"));
  const other = await prisma.forgejoIntegration.findUniqueOrThrow({ where: { organizationId: organizations[1] } });
  assert.match((await actions.rotateForgejoConnector(other.id)).error!, /no longer connected/);
  assert.match((await actions.resumeForgejoConnector(other.id)).error!, /no longer connected/);
  const actionJob = await prisma.forgejoConnectorRequest.create({ data: {
    integrationId: actionIntegration.id, method: "POST", requestEnc: "", status: "completed", responseEnc: encryptJson({ result: { body: '{"id":1}', headers: {} } }),
    expiresAt: new Date(Date.now() + 60_000), leaseToken: "c".repeat(64), leaseExpiresAt: new Date(Date.now() + 20_000),
  } });
  assert.match((await actions.rotateForgejoConnector(actionIntegration.id)).error!, /awaiting a result/);
  assert.equal((await prisma.forgejoIntegration.findUniqueOrThrow({ where: { id: actionIntegration.id } })).connectorTokenHash, hashConnectorToken(created.connectorToken!));
  await prisma.forgejoConnectorRequest.update({ where: { id: actionJob.id }, data: { status: "uncertain" } });
  await prisma.forgejoIntegration.update({ where: { id: actionIntegration.id }, data: { connectorError: "An interrupted write requires reconciliation." } });
  assert.match((await actions.resumeForgejoConnector(actionIntegration.id)).error!, /still running/);
  assert.match((await actions.rotateForgejoConnector(actionIntegration.id)).error!, /awaiting a result/);
  await prisma.forgejoConnectorRequest.update({ where: { id: actionJob.id }, data: { leaseExpiresAt: new Date(Date.now() - 1) } });
  const rotated = await actions.rotateForgejoConnector(actionIntegration.id);
  assert.ok(rotated.connectorToken);
  assert.ok((await prisma.forgejoIntegration.findUniqueOrThrow({ where: { id: actionIntegration.id } })).connectorError);
  assert.equal((await actions.resumeForgejoConnector(actionIntegration.id)).error, undefined);
  assert.equal((await prisma.forgejoIntegration.findUniqueOrThrow({ where: { id: actionIntegration.id } })).connectorError, null);
  assert.equal((await completed({ id: actionJob.id, leaseToken: "c".repeat(64) }, undefined, rotated.connectorToken)).status, 404);
  await prisma.organization.update({ where: { id: organizations[0] }, data: { bannedAt: new Date() } });
  assert.equal((await actions.rotateForgejoConnector(actionIntegration.id)).error, "Insufficient permissions.");
  assert.equal((await actions.resumeForgejoConnector(actionIntegration.id)).error, "Insufficient permissions.");
  assert.equal((await actions.disconnectForgejo()).error, "Insufficient permissions.");
  console.log("forgejo connector checks passed");
} finally {
  await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
}
