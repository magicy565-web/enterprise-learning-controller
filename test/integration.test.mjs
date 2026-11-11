import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PassThrough} from 'node:stream';
import {createInterface} from 'node:readline';
import {request} from 'node:http';
import {createLearningServer} from '../src/server.mjs';
import {digest} from '../src/domain.mjs';
import {post,clientConfiguration} from '../src/transport.mjs';
import {rpcHandler,serveStdio,TOOLS} from '../src/mcp.mjs';
import {initialize} from '../src/cli.mjs';
import {reviewFromArtifact} from '../src/import-review.mjs';
import {makeStore,obs,input,seed} from './helpers.mjs';
const src=name=>fileURLToPath(new URL(`../src/${name}`,import.meta.url));
async function app(t){const s=makeStore(),admin=randomBytes(32).toString('hex'),model=randomBytes(32).toString('hex');const a=createLearningServer({store:s,adminTokenHash:digest(admin),modelTokenHash:digest(model),owner:'fixture-owner',port:0});const addr=await a.listen();t.after(async()=>{await a.close();s.close();});return{s,a,owner:{url:`http://127.0.0.1:${addr.port}`,token:admin},model:{url:`http://127.0.0.1:${addr.port}`,token:model}};}
const call=(c,route,action,input={})=>post(c,route,{action,input});

test('real HTTP service rejects model credential at owner endpoint',async t=>{const a=await app(t);await assert.rejects(call(a.model,'/v1/owner','status'),e=>e.code==='UNAUTHORIZED');});
test('model API rejects approval, labels and holdout inspection',async t=>{const a=await app(t);for(const action of ['approve','observe','evaluate','publish','rollback','status'])await assert.rejects(call(a.model,'/v1/model',action),e=>e.code==='FORBIDDEN_ACTION');});
test('request cannot impersonate enterprise or reviewer',async t=>{const a=await app(t);await assert.rejects(post(a.owner,'/v1/owner',{action:'observe',input:obs('x'),actor:'forged'}),e=>e.code==='UNKNOWN_FIELD');await assert.rejects(call(a.owner,'/v1/owner','observe',{...obs('y'),enterpriseId:'other'}),e=>e.code==='UNKNOWN_FIELD');});
test('origin, host and unauthenticated writes are denied',async t=>{const a=await app(t);const r=await fetch(a.owner.url+'/v1/owner',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.invalid'},body:'{}'});assert.equal(r.status,403);const wrong=await new Promise((yes,no)=>{const req=request(a.owner.url+'/health',{headers:{host:'evil.invalid'}},res=>{res.resume();yes(res.statusCode);});req.on('error',no);req.end();});assert.equal(wrong,403);await assert.rejects(call({...a.owner,token:'a'.repeat(64)},'/v1/owner','status'));});
test('full HTTP feedback -> learn -> eval -> approve -> publish -> classify -> rollback',async t=>{
  const a=await app(t);
  for(let i=0;i<3;i++){
    await call(a.owner,'/v1/owner','observe',obs(`http-train-${i}`));
    await call(a.owner,'/v1/owner','observe',obs(`http-neg-${i}`,{split:'holdout'}));
    await call(a.owner,'/v1/owner','observe',obs(`http-pos-${i}`,{split:'holdout',role:'importer',label:'eligible',reason:'suitable_buyer'}));
  }
  const original=a.s.active();
  const learned=await call(a.model,'/v1/model','learn');const c=learned.candidate;
  const e=await call(a.owner,'/v1/owner','evaluate',{candidateId:c.id});assert.equal(e.passed,true);
  const approval=await call(a.owner,'/v1/owner','approve',{candidateId:c.id,reportId:e.id,candidateHash:digest(c)});
  const p=await call(a.owner,'/v1/owner','publish',{approvalId:approval.id,expectedActive:original.id});
  const run=await call(a.model,'/v1/model','classify',{id:'through-http',input:input('target'),expectedReleaseId:p.active});assert.equal(run.result.label,'ineligible');
  const r=await call(a.owner,'/v1/owner','rollback',{requestId:'undo-http',expectedActive:p.active,targetReleaseId:original.id});assert.equal(r.release.policy.allowedRoles.includes('retailer'),true);
});
test('MCP only advertises non-owner tools and negotiates known version',async()=>{const h=rpcHandler(async()=>({ok:true}));assert.equal((await h({jsonrpc:'2.0',id:1,method:'tools/list'})).error.code,-32000);const init=await h({jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'2099-01-01'}});assert.equal(init.result.protocolVersion,'2025-06-18');const tools=(await h({jsonrpc:'2.0',id:3,method:'tools/list'})).result.tools;assert.equal(tools.length,5);assert.ok(!JSON.stringify(tools.map(x=>x.name)).includes('publish'));assert.equal((await h({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'publish'}})).error.code,-32602);});
test('MCP errors become tool errors, no falsely successful result',async()=>{const h=rpcHandler(async()=>{throw Object.assign(new Error('no grant'),{code:'DENIED'});});await h({jsonrpc:'2.0',id:1,method:'initialize'});const r=await h({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'learning_context'}});assert.equal(r.result.isError,true);assert.match(r.result.content[0].text,/DENIED/);});
test('MCP newline transport handles split frames and malformed JSON',async()=>{const i=new PassThrough(),o=new PassThrough();let out='';o.on('data',c=>out+=c);const s=serveStdio(rpcHandler(async()=>({ok:true})),i,o);i.write('{"jsonrpc":"2.0","id":1,"method":"init');i.write('ialize"}\nnot-json\n');await s.settled();const rows=out.trim().split('\n').map(JSON.parse);assert.equal(rows[0].result.serverInfo.name,'enterprise-learning');assert.equal(rows[1].error.code,-32700);});
test('real spawned MCP broker calls real HTTP sidecar and exposes no credentials',async t=>{
  const a=await app(t),d=mkdtempSync(join(tmpdir(),'elc-mcp-'));t.after(()=>rmSync(d,{recursive:true,force:true}));const cfg=join(d,'client.json');writeFileSync(cfg,JSON.stringify(a.model));
  const child=spawn(process.execPath,[src('mcp.mjs'),'--client',cfg],{stdio:['pipe','pipe','pipe']});t.after(()=>child.kill());
  const lines=createInterface({input:child.stdout}),waiting=new Map();let all='',errors='';child.stderr.on('data',c=>errors+=c);
  lines.on('line',line=>{all+=line;const r=JSON.parse(line);waiting.get(r.id)?.(r);waiting.delete(r.id);});
  let seq=0;const ask=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>reject(new Error(`MCP timeout ${errors}`)),5000);waiting.set(id,r=>{clearTimeout(timer);resolve(r);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  await ask('initialize',{protocolVersion:'2025-06-18'});const r=await ask('tools/call',{name:'learning_context',arguments:{}});const data=JSON.parse(r.result.content[0].text);assert.equal(data.enterpriseId,'fixture-factory');assert.ok(!all.includes(a.model.token));assert.ok(!all.includes(a.owner.token));child.stdin.end();
});
test('initializer creates isolated state without sample enterprise records and refuses overwrite',t=>{const d=mkdtempSync(join(tmpdir(),'elc-init-'));t.after(()=>rmSync(d,{recursive:true,force:true}));const path=join(d,'new');const r=initialize({dir:path,enterpriseId:'actual-config',mode:'test',port:8892});assert.equal(readFileSync(r.serverConfig,'utf8').includes('adminTokenHash'),true);assert.notEqual(clientConfiguration(r.ownerClient).token,clientConfiguration(r.modelClient).token);assert.throws(()=>initialize({dir:path,enterpriseId:'actual-config'}),e=>e.code==='DIRECTORY_EXISTS');});
test('initializer validates before replacing existing data',t=>{const d=mkdtempSync(join(tmpdir(),'elc-init-'));t.after(()=>rmSync(d,{recursive:true,force:true}));assert.throws(()=>initialize({dir:join(d,'bad'),enterpriseId:'bad space'}));});
test('CLI reports failures with nonzero exit status',()=>{const r=spawnSync(process.execPath,[src('cli.mjs'),'init'],{encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/USAGE/);});
test('business-loop import verifies accepted artifact bytes and preserves synthetic scope',t=>{const d=mkdtempSync(join(tmpdir(),'elc-artifact-'));t.after(()=>rmSync(d,{recursive:true,force:true}));const art=join(d,'buyers.json'),progress=join(d,'execution-progress.json');writeFileSync(art,'{"buyer":"fixture only"}');writeFileSync(progress,JSON.stringify({id:'fixture-mandate',revision:1,synthetic:true,tasks:[{id:'buyers',state:'accepted',evidence:[{path:art,sha256:digest(readFileSync(art,'utf8'))}]}]}));const f=reviewFromArtifact({progressFile:progress,taskId:'buyers',artifactFile:art,feedback:obs('artifact')});assert.match(f.evidence.ref,/business-loop:fixture-mandate/);writeFileSync(art,'{"changed":true}');assert.throws(()=>reviewFromArtifact({progressFile:progress,taskId:'buyers',artifactFile:art,feedback:obs('artifact')}),e=>e.code==='HASH_MISMATCH');});
test('third independent owner correction automatically produces a candidate, not a release',async t=>{const a=await app(t),before=a.s.active().id;await call(a.owner,'/v1/owner','observe',obs('auto-a'));await call(a.owner,'/v1/owner','observe',obs('auto-b'));const third=await call(a.owner,'/v1/owner','observe',obs('auto-c'));assert.equal(third.learning.state,'candidate');assert.equal(a.s.active().id,before);assert.equal(a.s.all('candidates').length,1);const again=await call(a.owner,'/v1/owner','observe',obs('auto-c'));assert.equal(again.duplicate,true);assert.equal(a.s.all('candidates').length,1);});
test('learner failure does not undo an accepted owner correction',async t=>{const a=await app(t);a.s.learn=()=>{throw new Error('isolated failure injection');};const result=await call(a.owner,'/v1/owner','observe',obs('durable-feedback'));assert.equal(result.learning.state,'deferred');assert.equal(a.s.corpus().length,1);});
