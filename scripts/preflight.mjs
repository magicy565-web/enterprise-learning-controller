// Run this AS THE BOT'S OS ACCOUNT before connecting a real bot. It checks what the bot can and cannot reach.
import { accessSync, constants, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const canRead = file => { try { accessSync(file, constants.R_OK); return true; } catch { return false; } };
async function call(client, path, payload) {
  const r = await fetch(client.url + path, { method: payload ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${client.token}`, 'content-type': 'application/json' }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
export async function preflight({ modelClient, ownerClient, db, expectMode = 'production' }) {
  const model = JSON.parse(readFileSync(modelClient, 'utf8')), checks = [], add = (name, ok, detail) => checks.push({ name, ok, detail });
  const health = await call(model, '/health');
  add('service reachable on loopback', health.status === 200, `status ${health.status}`);
  add(`service mode is ${expectMode}`, health.body?.mode === expectMode, `mode ${health.body?.mode}`);
  const asOwner = await call(model, '/v1/owner', { action: 'status', input: {} });
  add('model credential is rejected by the owner API', asOwner.status === 401, `status ${asOwner.status}`);
  const ctx = await call(model, '/v1/model', { action: 'context', input: {} });
  add('model credential can read learning_context', ctx.status === 200 && Boolean(ctx.body?.enterpriseId), `enterprise ${ctx.body?.enterpriseId}`);
  add('holdout/owner data absent from model context', ctx.status === 200 && !JSON.stringify(ctx.body).includes('"holdout"'), 'no holdout split in payload');
  add('this account CANNOT read owner-client.json', !canRead(ownerClient), canRead(ownerClient) ? 'READABLE: the bot could approve and publish its own changes' : 'not readable');
  add('this account CANNOT read the database', !canRead(db), canRead(db) ? 'READABLE: the bot could read holdout labels' : 'not readable');
  return { ok: checks.every(c => c.ok), checks };
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { values } = parseArgs({ options: { 'model-client': { type: 'string' }, 'owner-client': { type: 'string' }, db: { type: 'string' }, 'expect-mode': { type: 'string' } } });
  if (!values['model-client'] || !values['owner-client'] || !values.db) { console.error('Usage: preflight.mjs --model-client F --owner-client F --db F [--expect-mode production|test]'); process.exit(2); }
  const result = await preflight({ modelClient: values['model-client'], ownerClient: values['owner-client'], db: values.db, expectMode: values['expect-mode'] ?? 'production' });
  for (const c of result.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
  process.exitCode = result.ok ? 0 : 1;
}
