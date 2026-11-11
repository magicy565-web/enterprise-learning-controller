import { randomUUID } from 'node:crypto';
import { buyer, classify, digest, identifier, insist, object, text } from './domain.mjs';

export const EXECUTION_ACTIONS = ['outbound_message', 'lead_write', 'artifact_submit'];

/** Host-only screening precondition. Never sends, queues, or grants a reusable execution token.
 * The authenticated host must derive input/payloadHash from the actual operation, enforce the
 * returned decision, and serialize dispatch with policy/pause changes if it needs that guarantee.
 */
export function checkExecution(store, raw, actor) {
  object(raw, ['enterpriseId', 'caseId', 'input', 'operationId', 'action', 'payloadHash', 'expectedMode'],
    ['enterpriseId', 'caseId', 'input', 'operationId', 'action', 'payloadHash']);
  const { enterpriseId, caseId, operationId, action, payloadHash, expectedMode = 'production' } = raw;
  [enterpriseId, caseId, operationId].forEach(identifier);
  actor = text(actor, 'authenticated actor', 120);
  insist(EXECUTION_ACTIONS.includes(action), 'INVALID_ACTION', 'Unsupported execution action');
  insist(typeof payloadHash === 'string' && /^[a-f0-9]{64}$/.test(payloadHash), 'INVALID_HASH', 'payloadHash must be a lowercase SHA-256');
  insist(['production', 'test'].includes(expectedMode), 'INVALID_MODE', 'Use production or test');
  const inputHash = digest(buyer(raw.input));

  return store.transaction(() => {
    // Any integrity/storage failure throws; a caller must treat errors/timeouts as denial.
    insist(Number(store.meta('db_version')) === store.codeVersion(store.migrationList), 'SCHEMA_MISMATCH', 'Database schema differs from this build', 409);
    insist(['true', 'false'].includes(store.meta('paused')), 'INTEGRITY_ERROR', 'Invalid pause state', 409);
    insist(store.verifyAudit().ok, 'INTEGRITY_ERROR', 'Audit chain failed verification', 409);
    const decision = { checkId: `check-${randomUUID()}`, checkedAt: new Date().toISOString(),
      enterpriseId: store.enterpriseId, mode: store.mode, operationId, action, payloadHash, caseId, inputHash };
    const finish = code => {
      const result = { ...decision, allowed: code === 'ALLOWED', code };
      store.audit('execution_checked', actor, { ...result, requestedEnterpriseId: enterpriseId, expectedMode });
      return result;
    };
    if (enterpriseId !== store.enterpriseId) return finish('ENTERPRISE_MISMATCH');
    if (expectedMode !== store.mode) return finish('MODE_MISMATCH');
    if (store.paused()) return finish('PAUSED');
    const active = store.active();
    decision.currentReleaseId = active.id;
    const run = store.get('cases', caseId);
    if (!run) return finish('RECEIPT_NOT_FOUND');
    const release = store.get('releases', run.releaseId);
    insist(run.enterpriseId === store.enterpriseId && run.scope === store.mode && release?.scope === store.mode,
      'INTEGRITY_ERROR', 'Receipt enterprise or scope is invalid', 409);
    insist(run.policyHash === digest(release.policy) && digest(run.result) === digest(classify(release.policy, run.input)),
      'INTEGRITY_ERROR', 'Receipt does not match its recorded policy', 409);
    decision.releaseId = run.releaseId;
    if (digest(run.input) !== inputHash) return finish('INPUT_MISMATCH');
    if (run.releaseId !== active.id) return finish('STALE_RECEIPT');
    if (run.result.label !== 'eligible') return finish('NOT_ELIGIBLE');
    const review = store.decode(store.db.prepare('SELECT body,sha FROM observations WHERE case_id=?').get(caseId));
    if (review) {
      if (review.label !== 'eligible') return finish('REVIEW_BLOCKED');
      if (review.corrected && digest(review.corrected) !== inputHash) return finish('REVIEW_INPUT_CHANGED');
    }
    return finish('ALLOWED');
  });
}
