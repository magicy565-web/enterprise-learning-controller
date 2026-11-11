// Entirely synthetic, isolated fixtures. Never imported by application startup.
import { LearningStore } from '../src/store.mjs';
import { digest } from '../src/domain.mjs';
export const makeStore = () => new LearningStore(':memory:', {enterpriseId:'fixture-factory', mode:'test'});
export const input = (n, role = 'retailer') => ({companyId:`${n}.example.invalid`,role,intentConfirmed:null,sourceRefs:[`fixture://${n}`]});
export const obs = (n, {split='train',role='retailer',label='ineligible',reason='wrong_buyer_role'}={}) => ({id:`obs-${n}`,caseId:`case-${n}`,input:input(n,role),label,reason,split,kind:'synthetic',evidence:{ref:`fixture://${n}/evidence`,text:`Synthetic fixture ${n}: ${role} business; reviewer labels ${label}.`}});
export function seed(store,{holdout=true}={}){
  for(let i=0;i<3;i++)store.ingest(obs(`train-${i}`),'fixture-owner');
  if(holdout)for(let i=0;i<3;i++){
    store.ingest(obs(`hold-neg-${i}`,{split:'holdout'}),'fixture-owner');
    store.ingest(obs(`hold-pos-${i}`,{split:'holdout',role:'importer',label:'eligible',reason:'suitable_buyer'}),'fixture-owner');
  }
}
export function candidate(store){return store.learn().candidate;}
export function ready(store){
  const c=candidate(store),r=store.evaluate(c.id,'fixture-owner');
  const a=store.approve({candidateId:c.id,reportId:r.id,candidateHash:digest(c)},'fixture-owner');
  return {c,r,a,base:store.active()};
}
export function release(store){const p=ready(store);return {...p,published:store.publish({approvalId:p.a.id,expectedActive:p.base.id},'fixture-owner').release};}
