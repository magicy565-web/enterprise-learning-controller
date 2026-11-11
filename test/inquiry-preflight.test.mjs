import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeStore, input } from './helpers.mjs';
import { inquiryLabel, splitFor } from '../src/domain.mjs';
import { ownerAction, createLearningServer } from '../src/server.mjs';
import { initialize } from '../src/cli.mjs';
import { LearningStore } from '../src/store.mjs';
import { preflight } from '../scripts/preflight.mjs';
const rejects = (fn, code) => assert.throws(fn, e => e.code === code);
const fixture = t => { const s = makeStore(); t.after(() => s.close()); return s; };
const run = (s, n, role = 'retailer') => s.runCase({ id: `run-${n}`, input: input(n, role), expectedReleaseId: s.active().id });
const inq = (n, extra = {}) => ({ id: `i-${n}`, caseId: `run-${n}`, verdict: 'valid', text: `Customer message for ${n}`, ref: `crm/${n}`, kind: 'synthetic', ...extra });

test('only verdicts that speak about the buyer become policy labels', () => {
  assert.deepEqual(inquiryLabel({ verdict: 'valid' }), { label: 'eligible', reason: 'suitable_buyer' });
  assert.deepEqual(inquiryLabel({ verdict: 'invalid', reason: 'wrong_buyer_role' }), { label: 'ineligible', reason: 'wrong_buyer_role' });
  assert.deepEqual(inquiryLabel({ verdict: 'invalid', reason: 'no_purchase_intent' }), { label: 'needs_review', reason: 'intent_not_verified' });
  for (const reason of ['not_target_product', 'spam_or_irrelevant', 'duplicate', 'other']) assert.equal(inquiryLabel({ verdict: 'invalid', reason }), null);
  assert.equal(inquiryLabel({ verdict: 'valid', corrected: {} }).reason, 'extraction_error');
});
test('company split is stable and roughly 20% holdout', () => {
  assert.equal(splitFor('a.example'), splitFor('a.example'));
  const n = Array.from({ length: 1000 }, (_, i) => splitFor(`c${i}.example`)).filter(x => x === 'holdout').length;
  assert.ok(n > 120 && n < 280, String(n));
});
test('valid inquiry becomes an eligible label from the recorded case input and an outcome', t => {
  const s = fixture(t); run(s, 'a', 'importer');
  const r = s.recordInquiry(inq('a'), 'sales'); assert.equal(r.usedForLearning, true);
  const o = s.corpus()[0]; assert.equal(o.label, 'eligible'); assert.equal(o.reason, 'suitable_buyer'); assert.equal(o.input.role, 'importer');
  assert.equal(s.outcomeSummary()[0].validInquiries, 1);
});
test('invalid inquiry for the wrong product is an outcome only, not a lesson', t => {
  const s = fixture(t); run(s, 'b');
  const r = s.recordInquiry(inq('b', { verdict: 'invalid', reason: 'not_target_product' }), 'sales');
  assert.equal(r.usedForLearning, false); assert.equal(s.corpus().length, 0); assert.equal(s.outcomeSummary()[0].invalidInquiries, 1);
});
test('wrong_buyer_role feeds the learner; three independent companies produce a candidate', t => {
  const s = fixture(t);
  for (let i = 0; i < 3; i++) { run(s, `w${i}`); s.recordInquiry(inq(`w${i}`, { verdict: 'invalid', reason: 'wrong_buyer_role', split: 'train' }), 'sales'); }
  assert.equal(s.learn().state, 'candidate');
});
test('a misextracted buyer is recorded as extraction_error with the corrected facts', t => {
  const s = fixture(t); run(s, 'm', 'retailer');
  s.recordInquiry(inq('m', { corrected: input('m', 'importer') }), 'sales');
  const o = s.corpus()[0]; assert.equal(o.reason, 'extraction_error'); assert.equal(o.corrected.role, 'importer');
});
test('validation, idempotency, conflicts and unknown cases', t => {
  const s = fixture(t); run(s, 'v');
  rejects(() => s.recordInquiry(inq('v', { verdict: 'invalid' }), 'x'), 'INVALID_REASON');
  rejects(() => s.recordInquiry(inq('v', { reason: 'spam_or_irrelevant' }), 'x'), 'INVALID_REASON');
  rejects(() => s.recordInquiry({ ...inq('zzz') }, 'x'), 'NOT_FOUND');
  rejects(() => s.recordInquiry({ ...inq('v'), input: input('v') }, 'x'), 'UNKNOWN_FIELD');   // input always comes from the recorded case
  s.recordInquiry(inq('v'), 'x');
  assert.equal(s.recordInquiry(inq('v'), 'x').duplicate, true);
  rejects(() => s.recordInquiry(inq('v', { verdict: 'invalid', reason: 'wrong_buyer_role' }), 'x'), 'ID_CONFLICT');
  assert.equal(s.corpus().length, 1);
});
test('a case cannot receive two different buyer labels from two inquiries', t => {
  const s = fixture(t); run(s, 'd');
  s.recordInquiry(inq('d'), 'x');
  rejects(() => s.recordInquiry({ ...inq('d'), id: 'i-d2', verdict: 'invalid', reason: 'wrong_buyer_role', ref: 'crm/d2', text: 'different' }, 'x'), 'CASE_CONFLICT');
});
test('owner inquiry action triggers bounded learning for training splits', t => {
  const s = fixture(t); let last;
  for (let i = 0; i < 3; i++) { run(s, `o${i}`); last = ownerAction(s, 'inquiry', inq(`o${i}`, { verdict: 'invalid', reason: 'wrong_buyer_role', split: 'train' }), 'owner'); }
  assert.equal(last.learning.state, 'candidate');
});

test('preflight passes the credential checks and flags readable owner files', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'elc-pre-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const info = initialize({ dir: join(dir, 'inst'), enterpriseId: 'pre', mode: 'test', port: 18947 });
  const cfg = JSON.parse(readFileSync(info.serverConfig, 'utf8')), store = new LearningStore(cfg.db, cfg);
  const app = createLearningServer({ ...cfg, store }); await app.listen(); t.after(async () => { await app.close(); store.close(); });
  const r = await preflight({ modelClient: info.modelClient, ownerClient: info.ownerClient, db: cfg.db, expectMode: 'test' });
  const by = Object.fromEntries(r.checks.map(c => [c.name, c.ok]));
  assert.equal(by['model credential is rejected by the owner API'], true);
  assert.equal(by['model credential can read learning_context'], true);
  assert.equal(by['this account CANNOT read owner-client.json'], false);   // same OS user as the service here, so it must be reported
  assert.equal(r.ok, false);
});

import { parseCsv, inquiriesFromCsv } from '../scripts/import-inquiries.mjs';
test('csv import handles quotes, commas, newlines and rejects unknown columns', () => {
  const rows = inquiriesFromCsv('id,caseId,verdict,reason,ref,text\ni1,c1,invalid,wrong_buyer_role,crm/1,"Hi, we are a ""retailer""\nonly"\ni2,c2,valid,,crm/2,Order 500 pcs\n');
  assert.equal(rows.length, 2); assert.equal(rows[0].text, 'Hi, we are a "retailer"\nonly'); assert.equal(rows[1].reason, undefined);
  assert.throws(() => inquiriesFromCsv('id,caseId,verdict,ref,text,price\n1,c,valid,r,t,9'), e => e.code === 'BAD_CSV');
  assert.throws(() => inquiriesFromCsv('id,verdict\n1,valid'), e => e.code === 'BAD_CSV');
  assert.deepEqual(parseCsv('a,b\r\n1,2'), [['a', 'b'], ['1', '2']]);
});
