import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { LearningStore } from '../src/store.mjs';
import { startBundled } from '../src/bundled.mjs';
import { makeStore, obs, input } from './helpers.mjs';
const rejects = (fn, code) => assert.throws(fn, e => e.code === code);
const tmp = t => { const d = mkdtempSync(join(tmpdir(), 'elc-b-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const rpc = (h, id, method, params) => h({ jsonrpc: '2.0', id, method, params });
const call = async (h, id, name, args = {}) => JSON.parse((await rpc(h, id, 'tools/call', { name, arguments: args })).result.content[0].text);

// ---- migrations
test('database gets a schema version, upgrades with a backup, and refuses downgrade', t => {
  const d = tmp(t), f = join(d, 'x.sqlite'), cfg = { enterpriseId: 'm', mode: 'test' };
  let s = new LearningStore(f, cfg); assert.equal(s.meta('db_version'), '1'); s.close();
  const up = { version: 2, name: 'add-extra', up: db => db.exec('ALTER TABLE outcomes ADD COLUMN extra TEXT') };
  s = new LearningStore(f, { ...cfg, migrations: [up] });
  assert.equal(s.meta('db_version'), '2'); assert.ok(s.db.prepare('PRAGMA table_info(outcomes)').all().some(c => c.name === 'extra'));
  assert.ok(readdirSync(d).some(n => n.includes('.pre-v1-') && n.endsWith('.bak')));
  assert.equal(s.verifyAudit().ok, true); s.close();
  s = new LearningStore(f, { ...cfg, migrations: [up] }); s.close();            // idempotent
  rejects(() => new LearningStore(f, cfg), 'DB_NEWER_THAN_CODE');                 // older software refuses newer data
});
test('a failing migration leaves the database at the old version, with a backup', t => {
  const d = tmp(t), f = join(d, 'y.sqlite'), cfg = { enterpriseId: 'm', mode: 'test' };
  new LearningStore(f, cfg).close();
  assert.throws(() => new LearningStore(f, { ...cfg, migrations: [{ version: 2, up: db => { db.exec('ALTER TABLE outcomes ADD COLUMN ok TEXT'); throw new Error('boom'); } }] }), /boom/);
  const s = new LearningStore(f, cfg); assert.equal(s.meta('db_version'), '1');
  assert.equal(s.db.prepare('PRAGMA table_info(outcomes)').all().some(c => c.name === 'ok'), false);   // partial change rolled back
  assert.ok(readdirSync(d).some(n => n.endsWith('.bak'))); s.close();
});
test('a database created before versioning is treated as v1', t => {
  const s = makeStore(); t.after(() => s.close()); s.db.prepare("DELETE FROM meta WHERE key='db_version'").run();
  s.migrate([]); assert.equal(s.meta('db_version'), '1');
});

// ---- learning switch
test('learning off still records labels, outcomes and receipts but creates no candidates', t => {
  const s = new LearningStore(':memory:', { enterpriseId: 'o', mode: 'test', learning: 'off' }); t.after(() => s.close());
  for (let i = 0; i < 3; i++) s.ingest(obs(`t${i}`), 'owner');
  assert.equal(s.learn().state, 'off'); assert.equal(s.corpus().length, 3);
  rejects(() => s.propose({ id: 'p', baseReleaseId: s.active().id, policy: { allowedRoles: ['importer'], requireIntent: false }, evidenceIds: ['obs-t0'], rationale: 'x' }), 'LEARNING_OFF');
  rejects(() => s.setShadow({ candidateId: 'p' }, 'owner'), 'LEARNING_OFF');
  assert.equal(s.runCase({ id: 'r1', input: input('z'), expectedReleaseId: s.active().id }).result.label, 'eligible');
  s.setLearning(true, 'admin-alice'); assert.equal(s.learn().state, 'candidate');
});
test('existing instances without the flag behave as before (learning on)', t => {
  const s = makeStore(); t.after(() => s.close()); s.db.prepare("DELETE FROM meta WHERE key='learning'").run(); assert.equal(s.learningOn(), true);
});

// ---- model-facing surface
test('context is small and hides holdout; examples are paged, capped and excerpted', t => {
  const s = makeStore(); t.after(() => s.close());
  for (let i = 0; i < 25; i++) s.ingest({ ...obs(`e${i}`), evidence: { ref: `r${i}`, text: 'x'.repeat(5000) } }, 'owner');
  s.ingest(obs('h', { split: 'holdout' }), 'owner');
  const c = s.summary(); assert.equal(c.trainingLabels, 25); assert.equal(c.observations, undefined); assert.ok(JSON.stringify(c).length < 4000);
  assert.ok(!JSON.stringify(c).includes('holdout'));
  const p = s.examples({ limit: 10 }); assert.equal(p.examples.length, 10); assert.equal(p.nextOffset, 10); assert.equal(p.examples[0].evidence.excerpt.length, 600); assert.equal(p.untrustedEvidence, true);
  assert.equal(s.examples({ limit: 20, offset: 20 }).nextOffset, null);
  rejects(() => s.examples({ limit: 21 }), 'INVALID_LIMIT');
});
test('receipt reports unknown cases, current vs stale release, and never leaks shadow', t => {
  const s = makeStore(); t.after(() => s.close());
  assert.deepEqual(s.receipt('nope'), { found: false, caseId: 'nope' });
  s.runCase({ id: 'k1', input: input('k'), expectedReleaseId: s.active().id });
  const r = s.receipt('k1'); assert.equal(r.found, true); assert.equal(r.label, 'eligible'); assert.equal(r.isCurrentRelease, true); assert.equal(r.shadow, undefined);
});

// ---- bundled service
test('first start self-initializes in observe-only mode; restart reuses; wrong enterprise refused', t => {
  const d = tmp(t);
  let svc = startBundled({ dataDir: join(d, 'ent'), enterpriseId: 'acme', mode: 'test' });
  assert.equal(svc.health().ok, true); assert.equal(svc.health().learning, 'off');
  const rel = svc.model('context').active.id; svc.close();
  svc = startBundled({ dataDir: join(d, 'ent'), enterpriseId: 'acme', mode: 'test' }); assert.equal(svc.model('context').active.id, rel); svc.close();
  rejects(() => startBundled({ dataDir: join(d, 'ent'), enterpriseId: 'other', mode: 'test' }), 'IDENTITY_MISMATCH');
  if (process.platform !== 'win32') assert.equal(statSync(join(d, 'ent', 'learning.sqlite')).mode & 0o077, 0);
});
test('model MCP cannot reach admin actions; host admin records the authenticated actor', async t => {
  const d = tmp(t), svc = startBundled({ dataDir: d, enterpriseId: 'acme', mode: 'test' }); t.after(() => svc.close());
  await rpc(svc.mcp, 1, 'initialize', { protocolVersion: '2025-06-18' });
  const ctx = await call(svc.mcp, 2, 'learning_context'); const out = await call(svc.mcp, 3, 'learning_classify', { id: 'c1', expectedReleaseId: ctx.active.id, input: input('bb') });
  assert.equal(out.result.label, 'eligible');
  assert.equal((await call(svc.mcp, 4, 'learning_receipt', { caseId: 'c1' })).found, true);
  const names = (await rpc(svc.mcp, 5, 'tools/list')).result.tools.map(x => x.name);
  for (const bad of ['publish', 'approve', 'observe', 'learning_enable', 'rollback']) assert.ok(!names.includes(bad));
  const refused = await rpc(svc.mcp, 6, 'tools/call', { name: 'publish', arguments: {} }); assert.ok(refused.error);
  assert.throws(() => svc.model('publish', {}), e => e.code === 'FORBIDDEN_ACTION');
  assert.throws(() => svc.admin('status', {}, ''), e => e.code === 'INVALID_TEXT');
  svc.admin('observe', { ...obs('alice-label'), caseId: 'c1', input: input('bb') }, 'alice@acme');
  assert.equal(svc.admin('learning', { enabled: true }, 'alice@acme').learning, 'on');
  const status = svc.admin('status', {}, 'alice@acme'); assert.equal(status.learning, 'on'); assert.equal(status.audit.ok, true);
  assert.ok(svc.model('context').trainingLabels >= 0);
});
test('stdio entry point serves the model tools from a real child process', async t => {
  const d = tmp(t), child = spawn(process.execPath, ['--no-warnings', new URL('../src/mcp-bundled.mjs', import.meta.url).pathname, '--data-dir', d, '--enterprise', 'stdio-ent', '--mode', 'test'], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill()); const lines = []; let buf = ''; child.stdout.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const ask = async (id, method, params) => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); for (let n = 0; n < 200; n++) { const r = lines.find(l => l.id === id); if (r) return r; await new Promise(r => setTimeout(r, 25)); } throw new Error('timeout'); };
  await ask(1, 'initialize', { protocolVersion: '2025-06-18' });
  const r = await ask(2, 'tools/call', { name: 'learning_context', arguments: {} });
  const ctx = JSON.parse(r.result.content[0].text); assert.equal(ctx.enterpriseId, 'stdio-ent'); assert.equal(ctx.learning, 'off');
  assert.ok(existsSync(join(d, 'learning.sqlite')));
});
