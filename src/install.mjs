import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { digest, insist } from './domain.mjs';
import { clientConfiguration, post } from './transport.mjs';

const START = '<!-- enterprise-learning-controller:v0.1 -->';
const END = '<!-- /enterprise-learning-controller -->';
export const GUIDANCE = `${START}\n${readFileSync(new URL('../skills/enterprise-learning-controller.md',import.meta.url),'utf8')}\n${END}`;
export function nativeClient(origin, token = '') {
  const url = new URL(origin);
  insist(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/' && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))), 'UNSAFE_URL','Native server requires HTTPS or loopback HTTP');
  return async (method, path, input) => {
    const r = await fetch(url.origin + path, {method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(input?{body:JSON.stringify(input)}:{})});
    const result = await r.json(); insist(r.ok,'NATIVE_API_ERROR',`Native API ${method} ${path}: status ${r.status}`,409); return result;
  };
}
/** Uses only routes observed in connect-magazine-tools.mjs. No provider keys, new runtime, or default model changes. */
export async function install({ api, clientFile, botId, makeChief = false, apply = false, journalFile, allowTest = false }) {
  clientFile = resolve(clientFile); clientConfiguration(clientFile);
  const bots = (await api('GET','/api/bots?messages=0')).bots;
  const chiefs = bots.filter(b => b.chiefOfStaff && !b.hidden);
  const bot = botId ? bots.find(b => b.id === botId) : chiefs.length === 1 ? chiefs[0] : null;
  insist(bot && !bot.busy,'BOT_UNAVAILABLE','Select an existing idle bot; multiple/no chiefs require --bot ID',409);
  insist(/^[A-Za-z0-9_-]{1,100}$/.test(bot.id),'INVALID_BOT','Unsafe bot id');
  const soul = bot.soul ?? '';
  insist(!soul.includes(START) || soul.includes(GUIDANCE),'MANAGED_CONFLICT','Managed instructions were edited; review instead of overwriting',409);
  const updatedSoul = soul.includes(GUIDANCE) ? soul : `${soul}\n\n${GUIDANCE}`;
  const name = `enterprise-learning-${bot.id}`;
  const spec = {command:process.execPath,args:[fileURLToPath(new URL('./mcp.mjs',import.meta.url)),'--client',clientFile],enabled:true,bot:bot.id,resultBudget:24000};
  const old = (await api('GET','/api/mcp/servers')).servers.find(s => s.name === name);
  insist(!old || (old.command === spec.command && JSON.stringify(old.args) === JSON.stringify(spec.args) && old.bot === bot.id),'CONNECTION_CONFLICT','A different connection already uses this managed name',409);
  const plan = {botId:bot.id,connection:name,instructionsHash:digest(updatedSoul),makeChief,mode:apply?'apply':'preview',alreadyInstalled:soul.includes(GUIDANCE)&&Boolean(old?.enabled)};
  if (!apply) return plan;
  const learning = await post(clientConfiguration(clientFile), '/v1/model', { action: 'context', input: {} });
  insist(learning.mode === 'production' || allowTest, 'TEST_SERVICE_REFUSED', 'A test service needs explicit --allow-test and an isolated native instance', 409);
  plan.enterpriseId = learning.enterpriseId; plan.learningMode = learning.mode;
  insist(journalFile,'JOURNAL_REQUIRED','--apply requires a fresh --journal FILE');
  journalFile=resolve(journalFile); insist(!existsSync(journalFile),'JOURNAL_EXISTS','Use a fresh journal file',409); mkdirSync(dirname(journalFile),{recursive:true,mode:0o700});
  const journal={...plan,before:{soul,mcpServers:bot.mcpServers??null,chiefOfStaff:Boolean(bot.chiefOfStaff)},phase:'prepared',at:new Date().toISOString()};
  writeFileSync(journalFile,JSON.stringify(journal,null,2),{mode:0o600,flag:'wx'});
  const save=phase=>{journal.phase=phase;writeFileSync(journalFile,JSON.stringify(journal,null,2),{mode:0o600});};
  if (!old) { await api('POST','/api/mcp/servers',{name,...spec,enabled:false}); save('connection-created-disabled'); await api('PUT',`/api/mcp/servers/${name}`,spec); }
  else if (!old.enabled) await api('PATCH',`/api/mcp/servers/${name}`,{enabled:true});
  save('connection-configured');
  const fresh=(await api('GET','/api/bots?messages=0')).bots.find(b=>b.id===bot.id);
  insist(fresh&&!fresh.busy&&fresh.soul===bot.soul&&JSON.stringify(fresh.mcpServers)===JSON.stringify(bot.mcpServers),'CONCURRENT_EDIT','Bot changed during setup; stop and reconcile journal',409);
  const patch={soul:updatedSoul,...(Array.isArray(bot.mcpServers)?{mcpServers:[...new Set([...bot.mcpServers,name])]}:{}),...(makeChief?{chiefOfStaff:true}:{})};
  await api('PATCH',`/api/bots/${bot.id}`,patch);save('bot-configured');
  const after=(await api('GET','/api/bots?messages=0')).bots.find(b=>b.id===bot.id);
  insist(after?.soul===updatedSoul&&(!Array.isArray(after.mcpServers)||after.mcpServers.includes(name))&&(!makeChief||after.chiefOfStaff),'READBACK_FAILED','Native readback did not confirm settings',409);
  save('configured-unverified');
  return {...plan,phase:journal.phase,journalFile,note:'Configuration read back. A live native model call is still required. No task, automatic review, or external send was started.'};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const {values}=parseArgs({options:{url:{type:'string'},bot:{type:'string'},client:{type:'string'},'token-file':{type:'string'},'make-chief':{type:'boolean'},apply:{type:'boolean'},journal:{type:'string'},'allow-test':{type:'boolean'}}});
  try{insist(values.url&&values.client,'USAGE','--url ORIGIN --client /path/model-client.json [--bot ID] [--apply --journal FILE]');
    console.log(JSON.stringify(await install({api:nativeClient(values.url,values['token-file']?readFileSync(values['token-file'],'utf8').trim():''),clientFile:values.client,botId:values.bot,makeChief:values['make-chief']===true,apply:values.apply===true,journalFile:values.journal,allowTest:values['allow-test']===true}),null,2));
  }catch(e){console.error(`${e.code??'ERROR'}: ${e.message}`);process.exitCode=1;}
}
