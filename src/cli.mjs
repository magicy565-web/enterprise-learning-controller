import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { LearningStore } from './store.mjs';
import { digest, insist, identifier } from './domain.mjs';
import { clientConfiguration, post, readJson } from './transport.mjs';

export function initialize({ dir, enterpriseId, mode = 'production', port = 8892, owner = 'local-owner', initialPolicy }) {
  identifier(enterpriseId); insist(Number.isInteger(port) && port >= 1024 && port <= 65535, 'INVALID_PORT', 'Use a port from 1024 to 65535');
  dir = resolve(dir); insist(!existsSync(dir), 'DIRECTORY_EXISTS', 'Initialization never overwrites an existing directory', 409);
  mkdirSync(dir, { recursive:true, mode:0o700 });
  try {
    const modelToken = randomBytes(32).toString('hex'), adminToken = randomBytes(32).toString('hex');
    const config = { enterpriseId, mode, port, owner, db: join(dir,'learning.sqlite'), modelTokenHash: digest(modelToken), adminTokenHash: digest(adminToken), ...(initialPolicy ? { initialPolicy } : {}) };
    const store = new LearningStore(config.db, config); store.close();
    for (const [name, value] of Object.entries({ 'server.json':config, 'model-client.json':{url:`http://127.0.0.1:${port}`,token:modelToken}, 'owner-client.json':{url:`http://127.0.0.1:${port}`,token:adminToken} })) {
      writeFileSync(join(dir,name), JSON.stringify(value,null,2)+'\n', { mode:0o600, flag:'wx' });
    }
    return { dir, enterpriseId, mode, serverConfig:join(dir,'server.json'), modelClient:join(dir,'model-client.json'), ownerClient:join(dir,'owner-client.json'), note:'No model connection or production service has been changed. Do not give the owner-client.json or DB to a bot.' };
  } catch (e) { rmSync(dir,{recursive:true,force:true}); throw e; }
}
export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args:argv, allowPositionals:true, options:{dir:{type:'string'},enterprise:{type:'string'},test:{type:'boolean'},port:{type:'string'},owner:{type:'string'},policy:{type:'string'},client:{type:'string'},input:{type:'string'}} });
  const action = positionals[0]; insist(positionals.length === 1, 'USAGE', 'Use init or one owner action');
  if (action === 'init') {
    insist(values.dir && values.enterprise, 'USAGE','init --dir PATH --enterprise ID [--test] [--policy FILE]');
    return initialize({dir:values.dir,enterpriseId:values.enterprise,mode:values.test?'test':'production',port:values.port?Number(values.port):8892,owner:values.owner??'local-owner',initialPolicy:values.policy?readJson(values.policy):undefined});
  }
  insist(values.client,'USAGE','ACTION --client /private/owner-client.json [--input request.json]');
  return post(clientConfiguration(values.client), '/v1/owner', {action,input:values.input?readJson(values.input):{}});
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.umask(0o077);
  try { console.log(JSON.stringify(await main(),null,2)); } catch (e) { console.error(`${e.code??'ERROR'}: ${e.message}`); process.exitCode=1; }
}
