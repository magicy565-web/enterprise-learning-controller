import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, obs, input, seed } from './helpers.mjs';
import { digest, binomialTail, wilson } from '../src/domain.mjs';
const rejects = (fn, code) => assert.throws(fn, e => e.code === code);
const fixture = t => { const s = makeStore(); t.after(() => s.close()); return s; };
const run = (s, n, role = 'retailer') => s.runCase({ id: `run-${n}`, input: input(n, role), expectedReleaseId: s.active().id });
const label = (s, n, role, lab, reason) => s.ingest({ ...obs(n, { role, label: lab, reason }), caseId: `run-${n}` }, 'owner');
// A candidate (drops retailer) shadowing live cases; retailers are wrong buyers, importers are good.
function shadowed(s, { retailers = 6, importers = 3 } = {}) {
  seed(s, { holdout: false }); const c = s.learn().candidate; s.setShadow({ candidateId: c.id }, 'owner');
  for (let i = 0; i < retailers; i++) { run(s, `sr${i}`); label(s, `sr${i}`, 'retailer', 'ineligible', 'wrong_buyer_role'); }
  for (let i = 0; i < importers; i++) { run(s, `si${i}`, 'importer'); label(s, `si${i}`, 'importer', 'eligible', 'suitable_buyer'); }
  return c;
}

test('statistics helpers', () => {
  assert.ok(Math.abs(binomialTail(6, 6) - 1 / 64) < 1e-12);
  assert.equal(binomialTail(5, 0), 1); assert.equal(binomialTail(3, 4), 0);
  const w = wilson(0, 10); assert.equal(w.low, 0); assert.ok(w.high > 0.2 && w.high < 0.35);
});
test('shadow answer is recorded but never returned to the worker', t => {
  const s = fixture(t); seed(s, { holdout: false }); const c = s.learn().candidate; s.setShadow({ candidateId: c.id }, 'owner');
  const out = run(s, 'x'); assert.equal(out.shadow, undefined); assert.equal(out.result.label, 'eligible');
  assert.equal(s.get('cases', 'run-x').shadow.result.label, 'ineligible');
  assert.equal(run(s, 'x').shadow, undefined);       // replay does not leak it either
});
test('shadow only records while the candidate baseline is still active; can be stopped', t => {
  const s = fixture(t); seed(s, { holdout: false }); const c = s.learn().candidate;
  rejects(() => s.setShadow({ candidateId: 'missing' }, 'owner'), 'NOT_FOUND');
  s.setShadow({ candidateId: c.id }, 'owner'); s.setShadow({ candidateId: null }, 'owner');
  run(s, 'y'); assert.equal(s.get('cases', 'run-y').shadow, undefined);
});
test('prospective paired evaluation passes, approves and publishes despite later labels', t => {
  const s = fixture(t); const c = shadowed(s);
  const r = s.evaluateShadow(c.id, 'owner');
  assert.equal(r.kind, 'shadow'); assert.equal(r.passed, true, JSON.stringify(r.reasons));
  assert.equal(r.paired.wins, 6); assert.equal(r.paired.losses, 0); assert.ok(r.paired.pValue < 0.05);
  assert.equal(s.evaluateShadow(c.id, 'owner').id, r.id);            // idempotent for the same snapshot
  const a = s.approve({ candidateId: c.id, reportId: r.id, candidateHash: digest(c) }, 'owner');
  run(s, 'later'); label(s, 'later', 'retailer', 'ineligible', 'wrong_buyer_role');   // continuous labeling must not stale the approval
  const pub = s.publish({ approvalId: a.id, expectedActive: s.active().id }, 'owner');
  assert.equal(pub.release.policy.allowedRoles.includes('retailer'), false);
});
test('shadow evaluation fails when the candidate loses or evidence is thin', t => {
  const bad = fixture(t); const c = shadowed(bad, { retailers: 2, importers: 3 });
  for (let i = 0; i < 4; i++) { run(bad, `gr${i}`); label(bad, `gr${i}`, 'retailer', 'eligible', 'suitable_buyer'); }   // good retailers the candidate would lose
  const r = bad.evaluateShadow(c.id, 'owner'); assert.equal(r.passed, false);
  assert.ok(r.reasons.includes('no_paired_improvement')); assert.ok(r.reasons.includes('eligible_recall_regressed'));
  rejects(() => bad.approve({ candidateId: c.id, reportId: r.id, candidateHash: digest(c) }, 'owner'), 'EVALUATION_FAILED');
  const thin = fixture(t); const c2 = shadowed(thin, { retailers: 2, importers: 0 });
  assert.ok(thin.evaluateShadow(c2.id, 'owner').reasons.includes('not_enough_prospective_labeled_cases'));
});
test('cases from the candidate’s own evidence companies and repeat companies do not count', t => {
  const s = fixture(t); seed(s, { holdout: false }); const c = s.learn().candidate; s.setShadow({ candidateId: c.id }, 'owner');
  for (let i = 0; i < 3; i++) { s.runCase({ id: `ev${i}`, input: input(`train-${i}`), expectedReleaseId: s.active().id }); }   // same companies as the training evidence
  assert.equal(s.evaluateShadow(c.id, 'owner').cases, 0);
});

test('review queue: random slice is reserved, disagreements first, no repeats, deterministic', t => {
  const s = fixture(t); seed(s, { holdout: false }); const c = s.learn().candidate; s.setShadow({ candidateId: c.id }, 'owner');
  for (let i = 0; i < 20; i++) run(s, `q${i}`, i % 2 ? 'retailer' : 'importer');   // retailers disagree with shadow
  const q = s.reviewQueue({ size: 10, seed: 'w1' }, 'owner');
  assert.equal(q.issued, 10);
  assert.ok(q.items.some(i => i.stratum === 'random'));
  assert.equal(q.items.filter(i => i.stratum === 'disagreement').length >= 6, true);
  const again = s.reviewQueue({ size: 10, seed: 'w1' }, 'owner');
  assert.equal(again.items.some(i => q.items.some(j => j.caseId === i.caseId)), false);
  const s2 = fixture(t); seed(s2, { holdout: false }); const c2 = s2.learn().candidate; s2.setShadow({ candidateId: c2.id }, 'owner');
  for (let i = 0; i < 20; i++) run(s2, `q${i}`, i % 2 ? 'retailer' : 'importer');
  assert.deepEqual(s2.reviewQueue({ size: 10, seed: 'w1' }, 'owner').items, q.items);
  rejects(() => s.reviewQueue({ size: 0 }, 'owner'), 'INVALID_SIZE');
});
test('calibration uses only the random stratum', t => {
  const s = fixture(t); for (let i = 0; i < 12; i++) run(s, `c${i}`);
  const q = s.reviewQueue({ size: 12, seed: 'cal' }, 'owner');
  for (const it of q.items) label(s, it.caseId.replace('run-', ''), 'retailer', it.stratum === 'random' ? 'ineligible' : 'eligible', it.stratum === 'random' ? 'wrong_buyer_role' : 'suitable_buyer');
  const cal = s.calibration(); assert.ok(cal.random >= 1); assert.equal(cal.accuracy, 0);   // active policy says eligible; random-stratum humans said ineligible
  assert.equal(s.status().calibration.random, cal.random);
});

test('outcomes attach to cases, are idempotent, validated, and summarized per policy version', t => {
  const s = fixture(t); run(s, 'o1'); run(s, 'o2'); run(s, 'o3', 'importer');
  const rel = s.active().id;
  s.recordOutcome({ id: 'e1', caseId: 'run-o1', event: 'customer_reply' }, 'sales-a');
  s.recordOutcome({ id: 'e2', caseId: 'run-o1', event: 'valid_inquiry', note: 'confirmed by sales' }, 'sales-a');
  s.recordOutcome({ id: 'e3', caseId: 'run-o2', event: 'invalid_inquiry' }, 'sales-a');
  assert.equal(s.recordOutcome({ id: 'e1', caseId: 'run-o1', event: 'customer_reply' }, 'sales-a').duplicate, true);
  rejects(() => s.recordOutcome({ id: 'e1', caseId: 'run-o1', event: 'valid_inquiry' }, 'sales-a'), 'ID_CONFLICT');
  rejects(() => s.recordOutcome({ id: 'e9', caseId: 'nope', event: 'customer_reply' }, 'x'), 'NOT_FOUND');
  rejects(() => s.recordOutcome({ id: 'e9', caseId: 'run-o1', event: 'sale_closed' }, 'x'), 'INVALID_EVENT');
  const cell = s.outcomeSummary().find(c => c.releaseId === rel && c.label === 'eligible');
  assert.deepEqual([cell.cases, cell.replied, cell.validInquiries, cell.invalidInquiries], [3, 1, 1, 1]);
  assert.ok(cell.interval95.low < cell.validInquiryRate && cell.validInquiryRate < cell.interval95.high);
});
