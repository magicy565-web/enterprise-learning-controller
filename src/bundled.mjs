// Embedding API for a host application (e.g. OpenMausBot) that ships this module as a built-in service.
// - First start creates and migrates the enterprise database by itself; no init step, no client files, no tokens.
// - Starts in observe-only mode (learning off) unless the host says otherwise.
// - The MCP handler exposes only model-safe actions. Owner/admin actions are a plain function the host calls with an
//   identity IT has authenticated; never route that function to the model.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LearningStore } from './store.mjs';
import { rpcHandler } from './mcp.mjs';
import { modelAction, ownerAction } from './server.mjs';
import { identifier, insist, text } from './domain.mjs';

export function startBundled({ dataDir, enterpriseId, mode = 'production', learning = 'off', initialPolicy } = {}) {
  insist(typeof dataDir === 'string' && dataDir.length > 0, 'DATA_DIR_REQUIRED', 'dataDir is required');
  identifier(enterpriseId);
  dataDir = resolve(dataDir); mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const store = new LearningStore(join(dataDir, 'learning.sqlite'), { enterpriseId, mode, learning, ...(initialPolicy ? { initialPolicy } : {}) });
  let closed = false;
  const ensureOpen = () => insist(!closed, 'CLOSED', 'Service is closed', 409);
  const model = (action, input = {}) => { ensureOpen(); return modelAction(store, action, input); };
  const admin = (action, input, actor) => { ensureOpen(); text(actor, 'authenticated actor', 120); return ownerAction(store, action, input ?? {}, actor); };
  return {
    enterpriseId, mode,
    /** JSON-RPC handler for the model-facing MCP tools (stdio or any transport the host provides). */
    mcp: rpcHandler(model),
    /** Model-safe actions; receipt lookup is informational, not execution authorization. */
    model,
    /** Owner/admin action performed by an identity the host has authenticated. `actor` is recorded in the audit log. */
    admin,
    /** Host-only, freshly evaluated screening check, with an audit entry for each decision. */
    checkExecution: (input, actor) => admin('check_execution', input, actor),
    health: () => { ensureOpen(); return store.doctor(); },
    close() { if (!closed) { closed = true; store.close(); } },
  };
}
