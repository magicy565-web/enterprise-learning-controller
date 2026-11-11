import { createHash } from 'node:crypto';

export class DomainError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'DomainError'; this.code = code; this.status = status; }
}
export function insist(ok, code, message, status = 400) { if (!ok) throw new DomainError(code, message, status); }
export function object(value, fields, required = fields) {
  insist(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_INPUT', 'Expected an object');
  insist(Object.keys(value).every(k => fields.includes(k)), 'UNKNOWN_FIELD', 'Unexpected fields are not permitted');
  insist(required.every(k => Object.hasOwn(value, k)), 'MISSING_FIELD', `Required: ${required.join(', ')}`);
  return value;
}
export function text(v, name, max = 2000) {
  insist(typeof v === 'string' && v.trim().length > 0 && v.length <= max && !v.includes('\u0000'), 'INVALID_TEXT', `Invalid ${name}`);
  return v.trim();
}
export function identifier(v) { text(v, 'id', 120); insist(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(v), 'INVALID_ID', 'Invalid identifier'); return v; }
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
export function digest(v) { return createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex'); }
export const ROLES = ['retailer', 'distributor', 'importer', 'brand'];
export const LABELS = ['eligible', 'ineligible', 'needs_review'];
export function policy(v) {
  object(v, ['allowedRoles', 'requireIntent']);
  insist(Array.isArray(v.allowedRoles) && v.allowedRoles.length > 0 && v.allowedRoles.length <= 4 && v.allowedRoles.every(x => ROLES.includes(x)) && new Set(v.allowedRoles).size === v.allowedRoles.length, 'INVALID_POLICY', 'Use distinct, supported allowedRoles');
  insist(typeof v.requireIntent === 'boolean', 'INVALID_POLICY', 'requireIntent must be boolean');
  return { allowedRoles: [...v.allowedRoles].sort(), requireIntent: v.requireIntent };
}
/** Case-fold and drop a trailing dot / leading "www." so trivial variants cannot bypass independence checks.
 *  Sub-domains and corporate groups are NOT collapsed (no public-suffix list); the labeler still owns that. */
export function normalizeCompanyId(id) {
  let v = id.trim().toLowerCase();
  if (v.endsWith('.')) v = v.slice(0, -1);
  if (v.startsWith('www.') && v.length > 4) v = v.slice(4);
  return v;
}
export function buyer(v) {
  object(v, ['companyId', 'role', 'intentConfirmed', 'sourceRefs']);
  const companyId = normalizeCompanyId(text(v.companyId, 'canonical company id', 200));
  insist(/^[a-z0-9][a-z0-9._:-]*$/.test(companyId), 'INVALID_COMPANY', 'Use a stable, normalized company id (usually its domain)');
  insist([...ROLES, 'unknown'].includes(v.role), 'INVALID_BUYER', 'Unsupported buyer role');
  insist(v.intentConfirmed === null || typeof v.intentConfirmed === 'boolean', 'INVALID_BUYER', 'Intent must be true, false, or null');
  insist(Array.isArray(v.sourceRefs) && v.sourceRefs.length <= 12, 'INVALID_BUYER', 'At most 12 source references');
  return { companyId, role: v.role, intentConfirmed: v.intentConfirmed, sourceRefs: [...new Set(v.sourceRefs.map(x => text(x, 'source reference', 1000)))].sort() };
}
export function classify(p, b) {
  if (!b.sourceRefs.length || b.role === 'unknown') return { label: 'needs_review', reason: 'missing_verified_role_or_source' };
  if (!p.allowedRoles.includes(b.role)) return { label: 'ineligible', reason: 'role_outside_approved_scope' };
  if (p.requireIntent && b.intentConfirmed !== true) return { label: 'needs_review', reason: 'intent_not_confirmed' };
  return { label: 'eligible', reason: 'matches_current_target_profile' };
}
/** The human-verified facts about a case: the corrected input when the model's extraction was wrong, else the run input.
 *  Records written before v0.2 have no `corrected`, so they fall back to `input` unchanged. */
export const truthOf = r => r.corrected ?? r.input;
export function observation(v) {
  object(v, ['id', 'caseId', 'input', 'label', 'reason', 'split', 'kind', 'evidence', 'corrected'], ['id', 'caseId', 'input', 'label', 'reason', 'split', 'kind', 'evidence']);
  identifier(v.id); identifier(v.caseId);
  const input = buyer(v.input);
  insist(LABELS.includes(v.label), 'INVALID_LABEL', 'Unsupported reviewer label');
  insist(['wrong_buyer_role', 'suitable_buyer', 'intent_not_verified', 'extraction_error', 'other'].includes(v.reason), 'INVALID_REASON', 'Unsupported correction reason');
  insist(['train', 'holdout'].includes(v.split), 'INVALID_SPLIT', 'Use train or holdout');
  insist(['real', 'synthetic'].includes(v.kind), 'INVALID_KIND', 'Use real or synthetic');
  // `input` must equal what the model actually ran with. A human who finds the model mis-extracted the buyer supplies the
  // verified facts in `corrected`, so an extraction error is never mistaken for a wrong screening policy.
  let corrected;
  if (v.corrected !== undefined) {
    insist(v.reason === 'extraction_error', 'INVALID_CORRECTION', 'corrected input is only allowed with reason extraction_error');
    corrected = buyer(v.corrected);
    insist(corrected.companyId === input.companyId, 'INVALID_CORRECTION', 'Correction cannot change the company');
    insist(digest(corrected) !== digest(input), 'INVALID_CORRECTION', 'Correction is identical to the run input');
  } else insist(v.reason !== 'extraction_error', 'INVALID_CORRECTION', 'extraction_error requires the corrected input');
  object(v.evidence, ['ref', 'text']);
  const evidence = { ref: text(v.evidence.ref, 'evidence ref', 1000), text: text(v.evidence.text, 'source evidence', 12000) };
  // Do not copy common credential formats into the learning corpus.
  insist(!/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat)[-_][A-Za-z0-9_\-]{16,}|\b(?:password|api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S+)/i.test(evidence.text), 'SECRET_DETECTED', 'Remove credentials before importing evidence');
  return { ...v, input, ...(corrected ? { corrected } : {}), evidence, evidenceHash: digest(evidence.text) };
}
export function measure(p, rows) {
  const out = { total: rows.length, correct: 0, eligible: 0, truePositive: 0, falsePositive: 0, needsReview: 0 };
  for (const r of rows) {
    const answer = classify(p, truthOf(r)).label;
    out.correct += Number(answer === r.label);
    out.eligible += Number(r.label === 'eligible');
    out.truePositive += Number(answer === 'eligible' && r.label === 'eligible');
    out.falsePositive += Number(answer === 'eligible' && r.label !== 'eligible');
    out.needsReview += Number(answer === 'needs_review');
  }
  return { ...out, accuracy: out.total ? out.correct / out.total : 0, recall: out.eligible ? out.truePositive / out.eligible : 0 };
}
