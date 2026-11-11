// Synthetic, isolated engineering fixtures. No external business actions are performed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../src/domain.mjs';
import { checkExecution } from '../src/execution-gate.mjs';
import { startBundled } from '../src/bundled.mjs';
import { LearningStore } from '../src/store.mjs';
import { createLearningServer, modelAction } from '../src/server.mjs';
import { post } from '../src/transport.mjs';
import { input, makeStore, obs, seed, release } from './helpers.mjs';

const request = (s, extra = {}) => ({ enterpriseId: s.enterpriseId, caseId: 'screened', input: input('gate'),
  operationId: 'operation-1', action: 'lead_write', payloadHash: digest('fixture payload'), expectedMode: 'test', ...extra });
const run = (s, id = 'screened', value = input('gate')) => s.runCase({ id, input: value, expectedReleaseId: s.active().id });
const fixture = t => { const s = makeStore(); t.after(() => s.close()); run(s); return s; };
const check = (s, extra = {}) => checkExecution(s, request(s, extra), 'host-reviewer');
const throwsCode = (fn, code) => assert.throws(fn, e => e.code === code);

test('gate allows normalized matching input and records actor, operation and payload hashes without evidence text', t => {
  const s = fixture(t), value = input('gate');
  value.companyId = 'WWW.GATE.EXAMPLE.INVALID.';
  value.sourceRefs.push(value.sourceRefs[0]);
  const result = check(s, { input: value });
  assert.equal(result.allowed, true); assert.equal(result.code, 'ALLOWED');
  assert.equal(result.inputHash, digest(input('gate'))); assert.equal(result.releaseId, s.active().id);
  const audit = s.db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT 1').get();
  assert.equal(audit.actor, 'host-reviewer'); assert.equal(audit.type, 'execution_checked');
  assert.equal(JSON.parse(audit.body).payloadHash, digest('fixture payload'));
  assert.ok(!audit.body.includes('fixture://')); assert.equal(s.verifyAudit().ok, true);
  assert.equal(s.receipt('screened').inputHash, result.inputHash);
  assert.equal(s.receipt('screened').enterpriseId, s.enterpriseId);
});

for (const [code, extra] of [
  ['ENTERPRISE_MISMATCH', { enterpriseId: 'different-enterprise' }],
  ['MODE_MISMATCH', { expectedMode: 'production' }],
  ['RECEIPT_NOT_FOUND', { caseId: 'missing' }],
  ['INPUT_MISMATCH', { input: input('another-company') }],
  ['INPUT_MISMATCH', { input: { ...input('gate'), role: 'importer' } }],
  ['INPUT_MISMATCH', { input: { ...input('gate'), intentConfirmed: true } }],
  ['INPUT_MISMATCH', { input: { ...input('gate'), sourceRefs: ['fixture://changed'] } }],
]) test(`gate denies ${code}: ${JSON.stringify(extra)}`, t => {
  const s = fixture(t), result = check(s, extra);
  assert.equal(result.allowed, false); assert.equal(result.code, code);
  assert.equal(s.verifyAudit().ok, true);
});

test('gate defaults to production, refuses unknown fields, bypass flags, invalid action and forged actor', t => {
  const s = fixture(t), r = request(s); delete r.expectedMode;
  assert.equal(checkExecution(s, r, 'host').code, 'MODE_MISMATCH');
  for (const extra of [{ allowStale: true }, { allowTest: true }, { actor: 'forged' }]) throwsCode(() => check(s, extra), 'UNKNOWN_FIELD');
  throwsCode(() => check(s, { action: 'publish_policy' }), 'INVALID_ACTION');
  throwsCode(() => check(s, { payloadHash: 'not-a-hash' }), 'INVALID_HASH');
  throwsCode(() => checkExecution(s, request(s), ''), 'INVALID_TEXT');
});

test('production gate works with production scope and no explicit mode override', t => {
  const s = new LearningStore(':memory:', { enterpriseId: 'production-scope' }); t.after(() => s.close());
  run(s); const r = request(s); delete r.expectedMode;
  assert.equal(checkExecution(s, r, 'host').allowed, true);
});

test('needs_review and ineligible results cannot pass the execution gate', t => {
  const s = fixture(t);
  run(s, 'unknown', input('unknown', 'unknown'));
  assert.equal(check(s, { caseId: 'unknown', input: input('unknown', 'unknown') }).code, 'NOT_ELIGIBLE');
  seed(s); release(s); run(s, 'rejected');
  assert.equal(check(s, { caseId: 'rejected' }).code, 'NOT_ELIGIBLE');
});

test('publication and rollback both invalidate old receipts; only new cases can pass', t => {
  const s = fixture(t); seed(s); const p = release(s);
  assert.equal(check(s).code, 'STALE_RECEIPT');
  s.rollback({ requestId: 'undo', expectedActive: p.published.id, targetReleaseId: p.base.id }, 'owner');
  assert.equal(check(s).code, 'STALE_RECEIPT'); // identical policy bytes still have a different release
  run(s, 'rescreened'); assert.equal(check(s, { caseId: 'rescreened' }).allowed, true);
});

test('every repeated operation is freshly evaluated; pause blocks previously allowed checks', t => {
  const s = fixture(t), first = check(s);
  s.pause(true, 'owner'); assert.equal(check(s).code, 'PAUSED');
  s.pause(false, 'owner'); const third = check(s);
  assert.equal(third.allowed, true); assert.notEqual(first.checkId, third.checkId);
});

for (const label of ['ineligible', 'needs_review']) test(`human ${label} review blocks a previously eligible receipt`, t => {
  const s = fixture(t); assert.equal(check(s).allowed, true);
  s.ingest({ ...obs('gate', { label }), caseId: 'screened' }, 'owner');
  assert.equal(check(s).code, 'REVIEW_BLOCKED'); assert.equal(s.receipt('screened').label, 'eligible');
});

test('a human extraction correction invalidates old input even if the corrected label is eligible', t => {
  const s = fixture(t);
  s.ingest({ ...obs('gate', { label: 'eligible', reason: 'extraction_error' }), caseId: 'screened', corrected: input('gate', 'importer') }, 'owner');
  assert.equal(check(s).code, 'REVIEW_INPUT_CHANGED');
});

for (const damage of ['audit', 'case', 'pause', 'schema', 'consistent-case-hash']) test(`gate fails closed for ${damage} corruption`, t => {
  const s = fixture(t);
  if (damage === 'audit') s.db.exec("UPDATE audit SET actor='tampered' WHERE seq=1");
  if (damage === 'case') s.db.exec("UPDATE cases SET sha='broken'");
  if (damage === 'pause') s.setMeta('paused', 'unknown');
  if (damage === 'schema') s.setMeta('db_version', '999');
  if (damage === 'consistent-case-hash') {
    const c = s.get('cases', 'screened'); c.result.reason = 'fabricated'; const body = JSON.stringify(c);
    s.db.prepare('UPDATE cases SET body=?,sha=? WHERE id=?').run(body, digest(body), c.id);
  }
  const before = s.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n;
  throwsCode(() => check(s), damage === 'schema' ? 'SCHEMA_MISMATCH' : 'INTEGRITY_ERROR');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, before);
});

test('audit write failure cannot return an allowed decision', t => {
  const s = fixture(t);
  s.db.exec("CREATE TRIGGER fail_gate BEFORE INSERT ON audit WHEN NEW.type='execution_checked' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
  assert.throws(() => check(s), /fixture write failure/);
  assert.equal(s.verifyAudit().ok, true);
});

test('HTTP owner can check execution; model token, model route and forged actor cannot', async t => {
  const s = fixture(t), admin = randomBytes(32).toString('hex'), model = randomBytes(32).toString('hex');
  const app = createLearningServer({ store: s, adminTokenHash: digest(admin), modelTokenHash: digest(model), port: 0 });
  const { port } = await app.listen(); t.after(() => app.close());
  const ownerClient = { url: `http://127.0.0.1:${port}`, token: admin }, modelClient = { ...ownerClient, token: model };
  const payload = { action: 'check_execution', input: request(s) };
  assert.equal((await post(ownerClient, '/v1/owner', payload)).allowed, true);
  await assert.rejects(post(modelClient, '/v1/owner', payload), e => e.code === 'UNAUTHORIZED');
  await assert.rejects(post(modelClient, '/v1/model', payload), e => e.code === 'FORBIDDEN_ACTION');
  await assert.rejects(post(ownerClient, '/v1/owner', { ...payload, actor: 'forged' }), e => e.code === 'UNKNOWN_FIELD');
  throwsCode(() => modelAction(s, 'check_execution', request(s)), 'FORBIDDEN_ACTION');
});

test('bundled host observes another connection pause, persists checks, and rejects all calls after close', async t => {
  const d = mkdtempSync(join(tmpdir(), 'elc-gate-')); t.after(() => rmSync(d, { recursive: true, force: true }));
  const config = { dataDir: d, enterpriseId: 'bundled-gate', mode: 'test' };
  const svc = startBundled(config), other = startBundled(config); t.after(() => { svc.close(); other.close(); });
  const r = request(svc);
  svc.model('classify', { id: 'screened', input: r.input, expectedReleaseId: svc.model('context').active.id });
  assert.equal(svc.checkExecution(r, 'host').allowed, true);
  other.admin('pause', { paused: true }, 'second-owner');
  assert.equal(svc.checkExecution(r, 'host').code, 'PAUSED');
  const count = svc.admin('audit', {}, 'host').count;
  svc.close(); other.close();
  const restarted = startBundled(config);
  try { assert.equal(restarted.admin('audit', {}, 'host').count, count); assert.equal(restarted.checkExecution(r, 'host').code, 'PAUSED'); }
  finally { restarted.close(); }
  for (const f of [() => svc.model('context'), () => svc.admin('status', {}, 'host'), () => svc.health(), () => svc.checkExecution(r, 'host')]) throwsCode(f, 'CLOSED');
  await svc.mcp({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  const denied = await svc.mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'learning_context', arguments: {} } });
  assert.equal(denied.result.isError, true); assert.match(denied.result.content[0].text, /CLOSED/);
});

test('turning learning off stops an already configured shadow without blocking classification', t => {
  const s = makeStore(); t.after(() => s.close()); seed(s);
  const c = s.learn().candidate; s.setShadow({ candidateId: c.id }, 'owner');
  run(s, 'before'); assert.equal(s.get('cases', 'before').shadow.candidateId, c.id);
  s.setLearning(false, 'owner'); run(s, 'after');
  assert.equal(s.summary().shadowing, false);
  assert.equal(s.get('cases', 'after').shadow, undefined);
  assert.equal(s.get('cases', 'before').shadow.candidateId, c.id);
});
