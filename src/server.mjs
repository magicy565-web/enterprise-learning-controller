import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { LearningStore } from './store.mjs';
import { DomainError, digest, identifier, insist, object } from './domain.mjs';
import { MAX_BODY, readJson } from './transport.mjs';

function matches(token, expectedHash) {
  if (!/^[0-9a-f]{64}$/.test(token ?? '') || !/^[0-9a-f]{64}$/.test(expectedHash ?? '')) return false;
  return timingSafeEqual(Buffer.from(digest(token), 'hex'), Buffer.from(expectedHash, 'hex'));
}
function send(res, status, body) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); }
async function body(req) {
  insist((req.headers['content-type'] ?? '').split(';')[0] === 'application/json', 'CONTENT_TYPE', 'JSON required', 415);
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; insist(length <= MAX_BODY, 'BODY_TOO_LARGE', 'Body too large', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new DomainError('INVALID_JSON', 'Invalid JSON'); }
}
export function modelAction(store, action, input) {
  if (action === 'context') { object(input, []); return store.context(); }
  if (action === 'learn') { object(input, []); return store.learn(); }
  if (action === 'propose') return store.propose(input);
  if (action === 'classify') { object(input, ['id', 'input', 'expectedReleaseId']); return store.runCase(input); }
  if (action === 'candidate') {
    object(input, ['id']); identifier(input.id); const c = store.get('candidates', input.id);
    insist(c, 'NOT_FOUND', 'Candidate not found', 404); return { candidate: c, sha256: digest(c) };
  }
  throw new DomainError('FORBIDDEN_ACTION', 'This tool identity cannot label data, inspect holdout, approve, publish, or change permissions', 403);
}
export function ownerAction(store, action, input, owner) {
  if (action === 'observe') {
    const receipt = store.ingest(input, owner);
    // Commit feedback first. A stopped/failed learner never loses an accepted review;
    // replaying the same event safely retries the bounded learning step.
    if (input.split !== 'train' || store.paused()) return { ...receipt, learning: { state: 'skipped' } };
    try {
      const learned = store.learn();
      return { ...receipt, learning: { state: learned.state, ...(learned.candidate ? { candidateId: learned.candidate.id } : {}) } };
    } catch (error) {
      return { ...receipt, learning: { state: 'deferred', code: error.code ?? 'LEARNING_FAILED' } };
    }
  }
  if (action === 'evaluate') { object(input, ['candidateId']); return store.evaluate(input.candidateId, owner); }
  if (action === 'approve') { object(input, ['candidateId', 'reportId', 'candidateHash']); return store.approve(input, owner); }
  if (action === 'publish') { object(input, ['approvalId', 'expectedActive']); return store.publish(input, owner); }
  if (action === 'rollback') { object(input, ['requestId', 'expectedActive', 'targetReleaseId']); return store.rollback(input, owner); }
  if (action === 'pause') { object(input, ['paused']); return store.pause(input.paused, owner); }
  if (action === 'shadow') { object(input, ['candidateId']); return store.setShadow(input, owner); }
  if (action === 'evaluate_shadow') { object(input, ['candidateId']); return store.evaluateShadow(input.candidateId, owner); }
  if (action === 'queue') { object(input, ['size', 'seed'], []); return store.reviewQueue(input, owner); }
  if (action === 'outcome') return store.recordOutcome(input, owner);
  if (action === 'audit') { object(input, []); return store.verifyAudit(); }
  if (action === 'status') { object(input, []); return store.status(); }
  return modelAction(store, action, input);
}
export function createLearningServer({ store, modelTokenHash, adminTokenHash, owner = 'local-owner', port = 8892 }) {
  insist(modelTokenHash !== adminTokenHash, 'CREDENTIAL_COLLISION', 'Owner and model credentials must differ');
  let window = Date.now(), requests = 0;
  const server = createServer(async (req, res) => {
    try {
      if (Date.now() - window > 60000) { window = Date.now(); requests = 0; }
      insist(++requests <= 300, 'RATE_LIMIT', 'Rate limit exceeded', 429);
      const actualPort = server.address()?.port;
      insist(req.headers.host === `127.0.0.1:${actualPort}`, 'HOST_REJECTED', 'Unexpected host', 403);
      insist(!req.headers.origin, 'ORIGIN_REJECTED', 'Browser origins are not accepted; use the owner CLI', 403);
      if (req.method === 'GET' && req.url === '/health') return send(res, 200, { service: 'enterprise-learning', version: '0.1.0', mode: store.mode });
      insist(req.method === 'POST' && ['/v1/model', '/v1/owner'].includes(req.url), 'NOT_FOUND', 'Route not found', 404);
      const token = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      const ownerRoute = req.url === '/v1/owner';
      insist(matches(token, ownerRoute ? adminTokenHash : modelTokenHash), 'UNAUTHORIZED', 'Invalid scoped credential', 401);
      const value = await body(req); object(value, ['action', 'input']);
      const result = ownerRoute ? ownerAction(store, value.action, value.input, owner) : modelAction(store, value.action, value.input);
      send(res, 200, result);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      send(res, error instanceof DomainError ? error.status : 500, { code: error.code ?? 'INTERNAL_ERROR', message: error instanceof DomainError ? error.message : 'Internal failure; inspect the local service' });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 30;
  return { server, listen: () => new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', () => { server.off('error', no); yes(server.address()); }); }),
    close: () => new Promise((yes, no) => { server.close(e => e ? no(e) : yes()); server.closeIdleConnections(); }) };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.umask(0o077);
  const { values } = parseArgs({ options: { config: { type: 'string' } } });
  insist(values.config, 'CONFIG_REQUIRED', 'Use --config /private/server.json');
  const cfg = readJson(values.config), store = new LearningStore(cfg.db, cfg);
  const app = createLearningServer({ ...cfg, store });
  await app.listen(); console.error(`enterprise-learning listening on 127.0.0.1:${cfg.port} (${cfg.mode})`);
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; await app.close(); store.close(); };
  process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
}
