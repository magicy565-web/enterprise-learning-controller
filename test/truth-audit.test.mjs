import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, obs, input, seed } from './helpers.mjs';
import { buyer, normalizeCompanyId } from '../src/domain.mjs';
const rejects = (fn, code) => assert.throws(fn, e => e.code === code);
const fixture = t => { const s = makeStore(); t.after(() => s.close()); return s; };

test('company ids are normalized: case, trailing dot and leading www', () => {
  assert.equal(normalizeCompanyId('WWW.Shop.Example.'), 'shop.example');
  assert.equal(buyer({ ...input('a'), companyId: 'WWW.A.example.invalid' }).companyId, 'a.example.invalid');
});
test('www variant of a training company cannot leak into holdout', t => {
  const s = fixture(t); s.ingest(obs('one'), 'owner');
  rejects(() => s.ingest({ ...obs('two', { split: 'holdout' }), input: { ...input('one'), companyId: 'www.one.example.invalid' } }, 'owner'), 'DATA_LEAKAGE');
});

const fix = (n, role, extra = {}) => ({ ...obs(n, { role: 'retailer', label: 'eligible', reason: 'extraction_error' }), corrected: input(n, role), ...extra });
test('extraction_error needs a real correction, and corrections need extraction_error', t => {
  const s = fixture(t);
  rejects(() => s.ingest({ ...obs('a'), reason: 'extraction_error' }, 'owner'), 'INVALID_CORRECTION');
  rejects(() => s.ingest({ ...obs('b'), corrected: input('b', 'importer') }, 'owner'), 'INVALID_CORRECTION');
  rejects(() => s.ingest(fix('c', 'retailer'), 'owner'), 'INVALID_CORRECTION');            // identical to run input
  rejects(() => s.ingest({ ...fix('d', 'importer'), corrected: input('other', 'importer') }, 'owner'), 'INVALID_CORRECTION'); // different company
});
test('model mis-extractions are not learned as "retailers are wrong"', t => {
  const s = fixture(t);
  // Three companies the model labeled retailer but which are really importers, humans flag the extraction.
  for (let i = 0; i < 3; i++) s.ingest(fix(`x${i}`, 'importer'), 'owner');
  assert.equal(s.learn().state, 'no_change');
});
test('genuine wrong-role retailers still trigger a candidate alongside extraction fixes', t => {
  const s = fixture(t);
  for (let i = 0; i < 3; i++) s.ingest(obs(`r${i}`), 'owner');
  s.ingest(fix('mistaken', 'importer'), 'owner');   // importer truth does not conflict with removing retailer
  assert.equal(s.learn().state, 'candidate');
});
test('corrected truth is what holdout evaluation measures', t => {
  const s = fixture(t); seed(s);
  const c = s.learn().candidate;
  // holdout row: model ran as retailer, human says truly an importer who is eligible -> must not count as a retailer error
  s.ingest({ ...fix('hold-fix', 'importer'), split: 'holdout' }, 'owner');
  const r = s.evaluate(c.id, 'owner');
  assert.equal(r.proposed.total, r.baseline.total);
  assert.equal(r.proposed.recall, 1);               // the corrected importer is still accepted by the candidate
});
test('context shows the correction to the model for training rows only', t => {
  const s = fixture(t); s.ingest(fix('t', 'importer'), 'owner');
  assert.equal(s.context().observations[0].corrected.role, 'importer');
});
test('records written before v0.2 (no corrected field) behave as before', t => {
  const s = fixture(t); seed(s);
  assert.ok(s.corpus().every(r => r.corrected === undefined));
  assert.equal(s.learn().state, 'candidate');
});

test('audit chain verifies and covers the lifecycle', t => {
  const s = fixture(t); seed(s); s.learn();
  const v = s.verifyAudit();
  assert.equal(v.ok, true); assert.ok(v.count >= 8);
  assert.equal(s.status().audit.ok, true);
});
test('audit detects edited, deleted-middle and truncated-tail records', t => {
  const s = fixture(t); seed(s, { holdout: false });
  const rows = () => s.db.prepare('SELECT seq FROM audit ORDER BY seq').all().map(r => r.seq);
  s.db.prepare("UPDATE audit SET actor='mallory' WHERE seq=2").run();
  assert.deepEqual([s.verifyAudit().ok, s.verifyAudit().reason], [false, 'hash_mismatch']);
  s.db.prepare("UPDATE audit SET actor='operator' WHERE seq=1").run();
  const s2 = fixture(t); seed(s2, { holdout: false });
  s2.db.prepare('DELETE FROM audit WHERE seq=2').run();
  assert.equal(s2.verifyAudit().reason, 'sequence_gap');
  const s3 = fixture(t); seed(s3, { holdout: false });
  s3.db.prepare('DELETE FROM audit WHERE seq=(SELECT MAX(seq) FROM audit)').run();
  assert.equal(s3.verifyAudit().reason, 'head_mismatch');
  assert.ok(rows().length > 0);
});
