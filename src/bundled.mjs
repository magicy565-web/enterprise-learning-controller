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
  return {
    enterpriseId, mode,
    /** JSON-RPC handler for the model-facing MCP tools (stdio or any transport the host provides). */
    mcp: rpcHandler((action, input) => modelAction(store, action, input)),
    /** Direct model action, e.g. for a host-side gate: admin-free, read-only `receipt` is the intended use. */
    model: (action, input = {}) => modelAction(store, action, input),
    /** Owner/admin action performed by an identity the host has authenticated. `actor` is recorded in the audit log. */
    admin(action, input, actor) { text(actor, 'authenticated actor', 120); insist(!closed, 'CLOSED', 'Service is closed', 409); return ownerAction(store, action, input ?? {}, actor); },
    health: () => store.doctor(),
    close() { if (!closed) { closed = true; store.close(); } },
  };
}
