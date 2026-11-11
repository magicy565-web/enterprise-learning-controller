// Native API contract fixture only. This does NOT claim a running OpenMausBot was verified.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GUIDANCE,install,nativeClient} from '../src/install.mjs';
import {createLearningServer} from '../src/server.mjs';
import {digest} from '../src/domain.mjs';
import {makeStore} from './helpers.mjs';
function fixture(){
  const state={bots:[{id:'otto',soul:'Keep existing external approval rules.',chiefOfStaff:true,busy:false,mcpServers:['old-tools']}],servers:[],writes:[]};
  const api=async(method,path,input)=>{
    if(method==='GET')return structuredClone(path.startsWith('/api/bots')?{bots:state.bots}:{servers:state.servers});
    state.writes.push({method,path,input:structuredClone(input)});
    if(path==='/api/mcp/servers')state.servers.push(structuredClone(input));
    else if(path.startsWith('/api/mcp/servers/'))Object.assign(state.servers.find(s=>s.name===path.split('/').at(-1)),input);
    else if(path==='/api/bots/otto')Object.assign(state.bots[0],input);
    else throw new Error(`Unexpected route ${method} ${path}`);
    return {};
  };return{state,api};
}
async function files(t){
  const d=mkdtempSync(join(tmpdir(),'elc-install-')),s=makeStore(),token=randomBytes(32).toString('hex');
  const app=createLearningServer({store:s,modelTokenHash:digest(token),adminTokenHash:digest(randomBytes(32).toString('hex')),port:0});const address=await app.listen();
  t.after(async()=>{await app.close();s.close();rmSync(d,{recursive:true,force:true});});
  const clientFile=join(d,'model.json');writeFileSync(clientFile,JSON.stringify({url:`http://127.0.0.1:${address.port}`,token}));return{d,clientFile};
}
test('native installer defaults to preview without side effects',async t=>{const f=await files(t),x=fixture();const r=await install({...f,api:x.api});assert.equal(r.botId,'otto');assert.equal(x.state.writes.length,0);});
test('native installer preserves existing soul, selection, and chief',async t=>{const f=await files(t),x=fixture();const r=await install({...f,api:x.api,apply:true,allowTest:true,journalFile:join(f.d,'j1.json')});assert.equal(r.phase,'configured-unverified');assert.ok(x.state.bots[0].soul.startsWith('Keep existing external approval rules.'));assert.ok(x.state.bots[0].soul.includes(GUIDANCE));assert.deepEqual(x.state.bots[0].mcpServers,['old-tools','enterprise-learning-otto']);assert.equal(x.state.bots[0].chiefOfStaff,true);assert.equal(x.state.servers[0].bot,'otto');});
test('native installation is idempotent and never creates another bot',async t=>{const f=await files(t),x=fixture();await install({...f,api:x.api,apply:true,allowTest:true,journalFile:join(f.d,'j1')});await install({...f,api:x.api,apply:true,allowTest:true,journalFile:join(f.d,'j2')});assert.equal(x.state.servers.length,1);assert.equal(x.state.bots.length,1);assert.equal(x.state.bots[0].soul.split('<!-- enterprise-learning-controller:v0.1 -->').length,2);});
test('test learning service is not silently attached to production',async t=>{const f=await files(t),x=fixture();await assert.rejects(install({...f,api:x.api,apply:true,journalFile:join(f.d,'j')}),e=>e.code==='TEST_SERVICE_REFUSED');assert.equal(x.state.writes.length,0);});
test('modified managed instruction block is not overwritten',async t=>{const f=await files(t),x=fixture();x.state.bots[0].soul='<!-- enterprise-learning-controller:v0.1 --> edited';await assert.rejects(install({...f,api:x.api}),e=>e.code==='MANAGED_CONFLICT');assert.equal(x.state.writes.length,0);});
test('conflicting managed MCP server is not overwritten',async t=>{const f=await files(t),x=fixture();x.state.servers.push({name:'enterprise-learning-otto',command:'other',args:[],bot:'otto'});await assert.rejects(install({...f,api:x.api}),e=>e.code==='CONNECTION_CONFLICT');});
test('busy or ambiguous chief is refused',async t=>{const f=await files(t),x=fixture();x.state.bots[0].busy=true;await assert.rejects(install({...f,api:x.api}),e=>e.code==='BOT_UNAVAILABLE');x.state.bots[0].busy=false;x.state.bots.push({...x.state.bots[0],id:'other'});await assert.rejects(install({...f,api:x.api}),e=>e.code==='BOT_UNAVAILABLE');});
test('concurrent soul edit stops installation without overwriting edit',async t=>{const f=await files(t),x=fixture();const api=async(m,p,b)=>{const r=await x.api(m,p,b);if(m==='PUT')x.state.bots[0].soul='Changed by owner during setup';return r;};await assert.rejects(install({...f,api,apply:true,allowTest:true,journalFile:join(f.d,'j')}),e=>e.code==='CONCURRENT_EDIT');assert.equal(x.state.bots[0].soul,'Changed by owner during setup');});
test('native client refuses insecure remote origin and embedded credentials',()=>{assert.throws(()=>nativeClient('http://example.invalid'));assert.throws(()=>nativeClient('https://u:p@example.invalid'));});
