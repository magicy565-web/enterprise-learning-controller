// Import a daily CSV of salesperson verdicts through the owner API. Dry-run unless --apply.
// Columns: id,caseId,verdict,reason,reviewer,ref,text   (reason only for invalid; text is the inquiry content)
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { clientConfiguration, post } from '../src/transport.mjs';

export function parseCsv(source) {
  const rows = []; let row = [], cell = '', quoted = false;
  const endCell = () => { row.push(cell); cell = ''; }, endRow = () => { endCell(); if (row.some(c => c !== '')) rows.push(row); row = []; };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) { if (ch === '"' && source[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; }
    else if (ch === '"') quoted = true; else if (ch === ',') endCell(); else if (ch === '\n') endRow(); else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) endRow();
  return rows;
}
export function inquiriesFromCsv(source) {
  const [header, ...body] = parseCsv(source.replace(/^\uFEFF/, ''));
  const need = ['id', 'caseId', 'verdict', 'ref', 'text'];
  if (!header || need.some(k => !header.includes(k))) throw Object.assign(new Error(`CSV needs columns: ${need.join(', ')}`), { code: 'BAD_CSV' });
  return body.map((cells, n) => {
    const rec = {}; header.forEach((k, i) => { if ((cells[i] ?? '') !== '') rec[k] = cells[i]; });
    const unknown = Object.keys(rec).filter(k => !['id', 'caseId', 'verdict', 'reason', 'reviewer', 'ref', 'text'].includes(k));
    if (unknown.length) throw Object.assign(new Error(`Row ${n + 2}: unexpected column ${unknown[0]}`), { code: 'BAD_CSV' });
    return rec;
  });
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { values } = parseArgs({ options: { csv: { type: 'string' }, client: { type: 'string' }, apply: { type: 'boolean' } } });
  try {
    if (!values.csv || !values.client) throw Object.assign(new Error('Usage: import-inquiries.mjs --csv FILE --client owner-client.json [--apply]'), { code: 'USAGE' });
    const items = inquiriesFromCsv(readFileSync(values.csv, 'utf8')), client = clientConfiguration(values.client), tally = { rows: items.length, usedForLearning: 0, outcomeOnly: 0, duplicates: 0, errors: [] };
    for (const item of items) {
      if (!values.apply) continue;
      try { const r = await post(client, '/v1/owner', { action: 'inquiry', input: item }); tally.duplicates += r.duplicate ? 1 : 0; r.usedForLearning ? tally.usedForLearning++ : tally.outcomeOnly++; }
      catch (e) { tally.errors.push({ id: item.id, code: e.code ?? 'ERROR', message: e.message }); }
    }
    console.log(JSON.stringify({ mode: values.apply ? 'applied' : 'dry-run (nothing sent; add --apply)', ...tally }, null, 2));
    process.exitCode = tally.errors.length ? 1 : 0;
  } catch (e) { console.error(`${e.code ?? 'ERROR'}: ${e.message}`); process.exitCode = 1; }
}
