// Executable isolated smoke. All cases below are synthetic and never enter a production DB.
import {mkdtempSync,rmSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {parseArgs} from 'node:util';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {LearningStore} from '../src/store.mjs';
import {createLearningServer} from '../src/server.mjs';
import {digest,insist} from '../src/domain.mjs';
import {post} from '../src/transport.mjs';
import {obs,input} from './helpers.mjs';

const {values}=parseArgs({options:{out:{type:'string'}}});
const output=values.out?resolve(values.out):null;
insist(!output||!existsSync(output),'OUTPUT_EXISTS','Use a new evidence output filename');
const dir=mkdtempSync(join(tmpdir(),'enterprise-learning-smoke-'));
const store=new LearningStore(join(dir,'smoke.sqlite'),{enterpriseId:'isolated-synthetic-fixture',mode:'test'});
const admin=randomBytes(32).toString('hex'),token=randomBytes(32).toString('hex');
const app=createLearningServer({store,adminTokenHash:digest(admin),modelTokenHash:digest(token),port:0});
let child;
try {
  const addr=await app.listen(),url=`http://127.0.0.1:${addr.port}`,owner={url,token:admin};
  const ownerCall=(action,input={})=>post(owner,'/v1/owner',{action,input});
  const clientPath=join(dir,'model.json');writeFileSync(clientPath,JSON.stringify({url,token}),{mode:0o600});
  child=spawn(process.execPath,[fileURLToPath(new URL('../src/mcp.mjs',import.meta.url)),'--client',clientPath],{stdio:['pipe','pipe','pipe']});
  let sequence=0;const pending=new Map(),lines=createInterface({input:child.stdout});let diagnostics='';child.stderr.on('data',c=>diagnostics+=c);
  lines.on('line',line=>{const reply=JSON.parse(line);pending.get(reply.id)?.(reply);pending.delete(reply.id);});
  const rpc=(method,params)=>new Promise((yes,no)=>{const id=++sequence,timer=setTimeout(()=>no(new Error(`MCP timeout: ${diagnostics}`)),5000);pending.set(id,r=>{clearTimeout(timer);yes(r);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  const tool=async(name,args={})=>{const r=await rpc('tools/call',{name,arguments:args});insist(r.result&&!r.result.isError,'MCP_FAILED',JSON.stringify(r.error??r.result));return JSON.parse(r.result.content[0].text);};
  await rpc('initialize',{protocolVersion:'2025-06-18'});
  const context=await tool('learning_context'),base=context.active;
  const before=await tool('learning_classify',{id:'before',input:input('target'),expectedReleaseId:base.id});
  const gate=caseId=>ownerCall('check_execution',{enterpriseId:context.enterpriseId,caseId,input:input('target'),operationId:'smoke-operation',action:'lead_write',payloadHash:digest('isolated fixture payload'),expectedMode:'test'});
  const gateBefore=await gate('before');
  for(let i=0;i<3;i++){
    await ownerCall('observe',obs(`smoke-train-${i}`));
    await ownerCall('observe',obs(`smoke-neg-${i}`,{split:'holdout'}));
    await ownerCall('observe',obs(`smoke-pos-${i}`,{split:'holdout',role:'importer',label:'eligible',reason:'suitable_buyer'}));
  }
  const candidate=(await tool('learning_learn')).candidate,report=await ownerCall('evaluate',{candidateId:candidate.id});
  const approval=await ownerCall('approve',{candidateId:candidate.id,reportId:report.id,candidateHash:digest(candidate)});
  const published=await ownerCall('publish',{approvalId:approval.id,expectedActive:base.id});
  const after=await tool('learning_classify',{id:'after',input:input('target'),expectedReleaseId:published.active});
  const gateStale=await gate('before'),gateRejected=await gate('after');
  const undo=await ownerCall('rollback',{requestId:'undo-smoke',expectedActive:published.active,targetReleaseId:base.id});
  const restored=await tool('learning_classify',{id:'restored',input:input('target'),expectedReleaseId:undo.active});
  const gateRestored=await gate('restored');
  await ownerCall('pause',{paused:true});
  const gatePaused=await gate('restored');
  insist(gateBefore.allowed&&gateStale.code==='STALE_RECEIPT'&&gateRejected.code==='NOT_ELIGIBLE'&&gateRestored.allowed&&gatePaused.code==='PAUSED','GATE_FAILED','Execution gate did not track lifecycle');
  const gateResults={before:gateBefore.code,oldReceiptAfterPublication:gateStale.code,afterPublication:gateRejected.code,rollback:gateRestored.code,paused:gatePaused.code};
  insist(before.result.label==='eligible'&&after.result.label==='ineligible'&&restored.result.label==='eligible','WRONG_RESULTS','Evolution/rollback did not change behavior as expected');
  const evidence={scope:'SYNTHETIC_ISOLATED_TEST_ONLY',at:new Date().toISOString(),node:process.version,nativeOpenMausBot:'NOT_RUN',realModel:'NOT_RUN',realBusinessOutcomes:'NOT_CLAIMED',network:'loopback HTTP plus spawned stdio MCP',observations:9,trainingCompanies:3,holdoutCompanies:6,baseline:report.baseline,proposed:report.proposed,evaluationPassed:report.passed,results:{before:before.result.label,after:after.result.label,rollback:restored.result.label},releaseIds:{baseline:base.id,published:published.active,rollback:undo.active},candidateId:candidate.id,reportId:report.id,approvalId:approval.id};
  evidence.executionGate=gateResults;
  evidence.hostOutboundIntegration='NOT_RUN';
  if(output){mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});}
  console.log(JSON.stringify(evidence,null,2));
} finally {child?.kill();await app.close();store.close();rmSync(dir,{recursive:true,force:true});}
