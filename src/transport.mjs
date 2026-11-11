import { readFileSync, statSync } from 'node:fs';
import { insist, object } from './domain.mjs';

export const MAX_BODY = 1024 * 1024;
export function readJson(file) {
  insist(statSync(file).isFile() && statSync(file).size <= MAX_BODY, 'FILE_TOO_LARGE', 'Input must be a JSON file <= 1 MiB');
  return JSON.parse(readFileSync(file, 'utf8'));
}
export function clientConfiguration(file) {
  const c = readJson(file); object(c, ['url', 'token']);
  const u = new URL(c.url);
  insist(u.protocol === 'http:' && u.hostname === '127.0.0.1' && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/', 'UNSAFE_URL', 'Learning sidecar must be on http://127.0.0.1:PORT');
  insist(typeof c.token === 'string' && /^[0-9a-f]{64}$/.test(c.token), 'INVALID_TOKEN', 'Invalid local client credential');
  return { url: u.origin, token: c.token };
}
export async function post(client, path, payload) {
  const response = await fetch(client.url + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${client.token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  let size = 0; const parts = [];
  for await (const chunk of response.body) { size += chunk.length; insist(size <= MAX_BODY, 'RESPONSE_TOO_LARGE', 'Sidecar response exceeded limit'); parts.push(chunk); }
  const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (!response.ok) { const error = new Error(body.message ?? body.error ?? 'Sidecar rejected request'); error.code = body.code ?? 'HTTP_ERROR'; throw error; }
  return body;
}
