// stdio MCP entry for hosts that launch built-in servers as child processes.
// It opens the enterprise database directly (WAL allows the host's admin process to open the same files).
//   node src/mcp-bundled.mjs --data-dir /path --enterprise ID [--mode production|test] [--learning on|off]
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startBundled } from './bundled.mjs';
import { serveStdio } from './mcp.mjs';
import { insist } from './domain.mjs';

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.umask(0o077);
  try {
    const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, enterprise: { type: 'string' }, mode: { type: 'string' }, learning: { type: 'string' } } });
    insist(values['data-dir'] && values.enterprise, 'USAGE', 'Use --data-dir PATH --enterprise ID');
    const service = startBundled({ dataDir: values['data-dir'], enterpriseId: values.enterprise, mode: values.mode ?? 'production', learning: values.learning ?? 'off' });
    serveStdio(service.mcp);
    process.stdin.on('close', () => { service.close(); });
  } catch (e) { console.error(`${e.code ?? 'ERROR'}: ${e.message}`); process.exitCode = 1; }
}
