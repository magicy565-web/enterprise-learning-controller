import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { digest, insist } from './domain.mjs';
import { clientConfiguration, post, readJson } from './transport.mjs';

/** Import a HUMAN label linked to an accepted file, not a claim that file acceptance means buyer qualification. */
export function reviewFromArtifact({ progressFile, taskId, artifactFile, feedback }) {
  progressFile=resolve(progressFile);artifactFile=resolve(artifactFile);
  const root=realpathSync(dirname(progressFile)), rel=relative(root,artifactFile);
  insist(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../')&&!rel.startsWith('..\\'),'OUTSIDE_WORKSPACE','Artifact outside mandate workspace');
  insist(!lstatSync(artifactFile).isSymbolicLink()&&realpathSync(artifactFile)===artifactFile,'UNSAFE_PATH','Artifact path must not follow symlinks');
  const stat=lstatSync(artifactFile);insist(stat.isFile()&&stat.size<=12000,'ARTIFACT_LIMIT','Use a text/JSON evidence artifact <= 12 KB');
  const bytes=readFileSync(artifactFile), progress=readJson(progressFile), task=progress.tasks?.find(t=>t.id===taskId);
  insist(task?.state==='accepted','UNACCEPTED_ARTIFACT','Task has not passed file acceptance',409);
  const hash=digest(bytes.toString('utf8'));
  insist(Buffer.from(bytes.toString('utf8'),'utf8').equals(bytes),'NON_TEXT_ARTIFACT','Only UTF-8 text artifacts are supported');
  insist(task.evidence?.some(e=>resolve(e.path)===artifactFile&&e.sha256===hash),'HASH_MISMATCH','Artifact differs from accepted evidence',409);
  insist(feedback.kind===(progress.synthetic===true?'synthetic':'real'),'KIND_MISMATCH','Feedback must preserve the mandate synthetic marker');
  return {...feedback,evidence:{ref:`business-loop:${progress.id}:${progress.revision}:${taskId}:${hash}`,text:bytes.toString('utf8')}};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const{values}=parseArgs({options:{progress:{type:'string'},task:{type:'string'},artifact:{type:'string'},feedback:{type:'string'},client:{type:'string'}}});
  try{for(const key of ['progress','task','artifact','feedback','client'])insist(values[key],'USAGE',`Missing --${key}`);
    const input=reviewFromArtifact({progressFile:values.progress,taskId:values.task,artifactFile:values.artifact,feedback:readJson(values.feedback)});
    console.log(JSON.stringify(await post(clientConfiguration(values.client),'/v1/owner',{action:'observe',input}),null,2));
  }catch(e){console.error(`${e.code??'ERROR'}: ${e.message}`);process.exitCode=1;}
}
