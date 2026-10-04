import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {FIRESTORE_ROOT,fromFirestore} from './firestore.mjs';
import {MODEL,DIMENSIONS,nativeVector} from './vectorize.mjs';
import {makeRecord} from './storage.mjs';
import {secretLike} from './core.js';
export class ChatError extends Error{constructor(message,status=503){super(message);this.status=status;this.code='CHAT_FAILED';}}
const fail=(m,s)=>{throw new ChatError(m,s);};
const decode=raw=>fromFirestore({mapValue:{fields:raw.fields}});
export function validateChat(x){
 if(!x||Object.keys(x).some(k=>!['question','history'].includes(k))||typeof x.question!=='string'||!x.question.trim()||x.question.length>2000||!Array.isArray(x.history)||x.history.length>6||x.history.some(m=>!m||Object.keys(m).some(k=>!['role','text'].includes(k))||!['user','assistant'].includes(m.role)||typeof m.text!=='string'||m.text.length>8000)||JSON.stringify(x).length>24000||secretLike(JSON.stringify(x)))fail('請檢查問題長度，並移除金鑰或識別欄位。',400);
 return x;
}
export function createChat({api,env=process.env,fetchImpl=fetch,readFileImpl=readFile,testOnly=false}={}){
 const collection=testOnly?'systemCheckChunks':'chunks',jobs=testOnly?'systemCheckJobs':'ingestionJobs',docs=testOnly?'systemChecks':'documents',type=testOnly?'system_test':'knowledge';
 async function model(action,payload){
  const r=await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models/'+action,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(60000)});
  if(!r.ok){await r.body?.cancel();fail('AI 問答暫時無法完成，請稍後重試。');}
  let size=0;const parts=[];for await(const b of r.body){size+=b.length;if(size>200000)fail('AI 回覆超過上限。');parts.push(b);}return JSON.parse(Buffer.concat(parts).toString('utf8'));
 }
 return {async ask(input){
  validateChat(input);
  const template=await readFileImpl(new URL('./prompt-embedding-document.txt',import.meta.url),'utf8');
  const configHash=createHash('sha256').update(JSON.stringify({model:MODEL,dimensions:DIMENSIONS,chunking:'unicode1800_overlap150_boundary900_v1',template})).digest('hex');
  const where={compositeFilter:{op:'AND',filters:[
   {fieldFilter:{field:{fieldPath:'recordType'},op:'EQUAL',value:{stringValue:type}}},
   {fieldFilter:{field:{fieldPath:'configHash'},op:'EQUAL',value:{stringValue:configHash}}},
   {fieldFilter:{field:{fieldPath:'searchReady'},op:'EQUAL',value:{booleanValue:true}}}
  ]}};
  const queryTemplate=await readFileImpl(new URL('./prompt-embedding-query.txt',import.meta.url),'utf8');
  const query=input.history.filter(m=>m.role==='user').map(m=>m.text).concat(input.question).join('\n');
  const e=await model(MODEL+':embedContent',{model:'models/'+MODEL,content:{parts:[{text:queryTemplate.replace('{{content}}',()=>query)}]},outputDimensionality:DIMENSIONS});
  const queryVector=nativeVector(e.embedding?.values);
  let response;
  try{response=await api(FIRESTORE_ROOT+':runQuery',{method:'POST',json:{structuredQuery:{from:[{collectionId:collection}],where,findNearest:{vectorField:{fieldPath:'embedding'},queryVector,distanceMeasure:'COSINE',limit:5}}}});}catch{fail('原生向量查詢未完成，請確認 Firestore 向量索引已就緒及服務帳戶查詢權限。');}
  if(!Array.isArray(response))fail('知識搜尋回覆格式不正確。');
  const rows=response.filter(r=>r.document).map(r=>r.document);
  const candidates=[],cache=new Map();
  for(const raw of rows){
   const {embedding,...fields}=raw.fields;const c=decode({fields});
   if(c.searchReady!==true||c.recordType!==type||c.configHash!==configHash||c.model!==MODEL||c.dimensions!==DIMENSIONS||!/^SEAG-[a-f0-9]{64}$/.test(c.documentId))continue;
   if(!cache.has(c.documentId)){
    const j=await api(FIRESTORE_ROOT+'/'+jobs+'/'+c.documentId,{allow404:true});
    const job=j&&decode(j);let doc=null;
    if(job?.status==='ready'&&job.configHash===configHash){const d=await api(FIRESTORE_ROOT+'/'+docs+'/'+c.documentId,{allow404:true});doc=d&&decode(d);if(doc){const record=makeRecord({...Object.fromEntries(['title','body','metadata','sourceCount'].map(k=>[k,doc[k]])),confirmed:true});if(doc.recordType!==type||doc.humanConfirmed!==true||record.id!==c.documentId||record.digest!==doc.contentSha256)fail('知識稿完整性檢查失敗。');}}
    cache.set(c.documentId,doc);
   }
   const d=cache.get(c.documentId);if(!d)continue;
   if(c.contentSha256!==d.contentSha256||!Number.isInteger(c.start)||!Number.isInteger(c.end)||c.start<0||c.end<=c.start||[...d.body].slice(c.start,c.end).join('')!==c.text)fail('知識段落完整性檢查失敗。');
   candidates.push({c,d});
  }
  if(!candidates.length)return {answer:'目前沒有已完成向量化的正式稿。請先匯入並確認儲存，再由管理者手動完成向量化。',sources:[]};
  const sources=candidates.map(({c,d},i)=>({id:'S'+(i+1),documentId:c.documentId,title:d.title,text:c.text}));
  const system=await readFileImpl(new URL('./prompt-chat.txt',import.meta.url),'utf8');
  const r=await model('gemini-3.5-flash-lite:generateContent',{systemInstruction:{parts:[{text:system}]},contents:[{role:'user',parts:[{text:JSON.stringify({...input,sources})}]}],generationConfig:{responseMimeType:'application/json',maxOutputTokens:4096}});
  const candidate=r.candidates?.[0];if(candidate?.finishReason!=='STOP')fail('回答尚未完整，請重新提問。');
  let result;try{result=JSON.parse(candidate.content.parts.filter(p=>!p.thought).map(p=>p.text||'').join(''));}catch{fail('回答格式不正確，請重試。');}
  if(typeof result.answer!=='string'||!result.answer.trim()||result.answer.length>8000||!Array.isArray(result.sourceIds)||result.sourceIds.some(id=>!sources.some(s=>s.id===id))||[...result.answer.matchAll(/\[(S\d+)\]/g)].some(m=>!result.sourceIds.includes(m[1]))||secretLike(result.answer)||['GEMINI_API_KEY','SEAG_ACCESS_TOKEN','SEAG_ADMIN_TOKEN'].some(k=>env[k]&&result.answer.includes(env[k])))fail('回答未通過來源或安全檢查。');
  return {answer:result.answer,sources:sources.filter(s=>result.sourceIds.includes(s.id))};
 }};
}
