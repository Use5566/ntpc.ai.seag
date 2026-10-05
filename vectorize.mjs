import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {FIRESTORE_ROOT,firestoreFields,fromFirestore} from './firestore.mjs';
import {keywordTokens} from './hybrid.mjs';
import {isCurrent} from './revisions.mjs';
import {makeRecord,recordInput} from './storage.mjs';
export const MODEL='gemini-embedding-2',DIMENSIONS=1536,BATCH_SIZE=3;
export class VectorError extends Error{constructor(code,message,status=503){super(message);this.code=code;this.status=status;}}
const fail=(code,message,status)=>{throw new VectorError(code,message,status);};
const hash=s=>createHash('sha256').update(s).digest('hex');
const decode=d=>fromFirestore({mapValue:{fields:d.fields||{}}});
const validId=id=>typeof id==='string'&&/^SEAG-[a-f0-9]{64}$/.test(id);
// Offsets count Unicode code points. No source characters are dropped.
export function splitText(text){
 const chars=[...text],chunks=[];let start=0;
 while(start<chars.length){let end=Math.min(start+1800,chars.length);
  if(end<chars.length){for(let i=end-1;i>start+900;i--){if(/[\n。！？!?]/u.test(chars[i])){end=i+1;break;}}}
  chunks.push({start,end,text:chars.slice(start,end).join('')});
  if(end===chars.length)break;start=end-150;
 }
 return chunks;
}
export function nativeVector(values){
 if(!Array.isArray(values)||values.length!==DIMENSIONS||values.some(v=>typeof v!=='number'||!Number.isFinite(v)))fail('VECTOR_RESULT','向量回覆格式不正確，請稍後手動重試。');
 const norm=Math.hypot(...values);if(!Number.isFinite(norm)||norm<1e-10)fail('VECTOR_RESULT','向量回覆無效，請稍後手動重試。');
 return {mapValue:{fields:{__type__:{stringValue:'__vector__'},value:{arrayValue:{values:values.map(v=>({doubleValue:v/norm}))}}}}};
}
export function createVectorizer({api,env=process.env,fetchImpl=fetch,now=Date.now,readFileImpl=readFile,testOnly=false}={}){
 const docs=testOnly?'systemChecks':'documents',jobs=testOnly?'systemCheckJobs':'ingestionJobs',chunksCollection=testOnly?'systemCheckChunks':'chunks';
 const name=(collection,id)=>FIRESTORE_ROOT.slice('https://firestore.googleapis.com/v1/'.length)+'/'+collection+'/'+id;
 let templatePromise;
 async function config(){
  templatePromise??=readFileImpl(new URL('./prompt-embedding-document.txt',import.meta.url),'utf8');
  const template=await templatePromise;
  if(template.length>2000||template.split('{{title}}').length!==2||template.split('{{content}}').length!==2)fail('VECTOR_CONFIG','向量提示詞範本格式不正確。');
  return {template,configHash:hash(JSON.stringify({model:MODEL,dimensions:DIMENSIONS,chunking:'unicode1800_overlap150_boundary900_v1',template}))};
 }
 async function load(id){
  if(!validId(id))fail('VECTOR_INPUT','稿件編號不正確。',400);
  const [raw,job]=await Promise.all([api(FIRESTORE_ROOT+'/'+docs+'/'+id,{allow404:true}),api(FIRESTORE_ROOT+'/'+jobs+'/'+id,{allow404:true})]);
  if(!raw||!job)fail('VECTOR_MISSING','找不到正式稿或處理紀錄。',404);
  const d=decode(raw),j=decode(job);
  if(d.recordType!==(testOnly?'system_test':'knowledge')||d.humanConfirmed!==true)fail('VECTOR_INPUT','只處理經人工確認的正式稿。',400);
  let record;try{record=makeRecord(recordInput(d));}catch{fail('VECTOR_INTEGRITY','稿件格式不正確，請管理者檢查。');}
  if(record.id!==id||record.digest!==d.contentSha256||j.contentSha256!==record.digest||j.documentId!==id)fail('VECTOR_INTEGRITY','稿件內容與指紋不一致，未呼叫向量模型。');
  if(!await isCurrent(api,d,testOnly))fail('VECTOR_VERSION','此版本已被取代，請選擇最新版本。',409);
  const cfg=await config(),parts=splitText(d.body);
  if(j.configHash&&j.configHash!==cfg.configHash)fail('VECTOR_VERSION','向量設定已變更，請先規劃重新建立索引，避免混用版本。',409);
  const completed=j.completedChunks||0;
  if(!Number.isSafeInteger(completed)||completed<0||completed>parts.length)fail('VECTOR_INTEGRITY','處理進度不正確。');
  return {d,j,raw,job,parts,completed,...cfg,planHash:hash(id+cfg.configHash)};
 }
 const summary=p=>({documentId:p.d.recordId,title:p.d.title,model:MODEL,dimensions:DIMENSIONS,totalChunks:p.parts.length,completedChunks:p.completed,remainingChunks:p.parts.length-p.completed,maxChunksPerClick:BATCH_SIZE,nextInputCharacters:p.parts.slice(p.completed,p.completed+BATCH_SIZE).reduce((n,c)=>n+[...c.text].length+[...p.d.title].length+p.template.length,0),planHash:p.planHash,status:p.j.status,attempts:p.j.attempts||0,embeddingRequests:p.j.embeddingRequests||0,searchPublished:p.j.searchPublished===true&&p.j.lexicalVersion==='bigrams_v1'});
 async function list({pageToken=''}={}){
  if(typeof pageToken!=='string'||pageToken.length>3000)fail('VECTOR_INPUT','分頁資訊不正確。',400);
  const r=await api(FIRESTORE_ROOT+'/'+jobs+'?pageSize=20'+(pageToken?'&pageToken='+encodeURIComponent(pageToken):''));
  const items=await Promise.all((r.documents||[]).map(async raw=>{const j=decode(raw);if(!validId(j.documentId))return null;const d=await api(FIRESTORE_ROOT+'/'+docs+'/'+j.documentId,{allow404:true});return {documentId:j.documentId,title:d?.fields?.title?.stringValue||'稿件不存在',status:j.status,completedChunks:j.completedChunks||0,totalChunks:j.totalChunks||null};}));
  return {items:items.filter(Boolean),nextPageToken:r.nextPageToken||''};
 }
 async function preview({documentId}){return summary(await load(documentId));}
 const jobWrite=(p,j)=>({update:{name:name(jobs,p.d.recordId),fields:firestoreFields(j)},currentDocument:{updateTime:p.job.updateTime}});
 async function updateJob(p,j,extra=[]){
  await api(FIRESTORE_ROOT+':commit',{method:'POST',json:{writes:[...extra,jobWrite(p,j)]}});
  const raw=await api(FIRESTORE_ROOT+'/'+jobs+'/'+p.d.recordId);p.job=raw;p.j=decode(raw);p.completed=p.j.completedChunks||0;
 }
 // Publish all chunks atomically only after the entire document is complete.
 async function publish(p){
  if(p.completed!==p.parts.length)fail('VECTOR_INTEGRITY','尚未完成的稿件不可開放查詢。');
  if(p.j.searchPublished===true&&p.j.lexicalVersion==='bigrams_v1')return;
  if(!await isCurrent(api,p.d,testOnly))fail('VECTOR_VERSION','此版本已被取代。',409);
  const writes=[];
  for(let index=0;index<p.parts.length;index++){
   const id=p.d.recordId+'_'+p.configHash.slice(0,16)+'_'+String(index).padStart(4,'0');
   const raw=await api(FIRESTORE_ROOT+'/'+chunksCollection+'/'+id,{allow404:true});
   if(!raw)fail('VECTOR_INTEGRITY','向量段落缺失，未開放查詢。');
   const {embedding,...fields}=raw.fields;const c=decode({fields}),part=p.parts[index];
   if(c.documentId!==p.d.recordId||c.configHash!==p.configHash||c.contentSha256!==p.d.contentSha256||c.text!==part.text||c.index!==index||c.start!==part.start||c.end!==part.end)fail('VECTOR_INTEGRITY','向量段落不一致，未開放查詢。');
   nativeVector(embedding?.mapValue?.fields?.value?.arrayValue?.values?.map(v=>v.doubleValue??Number(v.integerValue)));
   writes.push({update:{name:raw.name,fields:firestoreFields({searchReady:true,keywordTokens:keywordTokens(p.d.title+' '+part.text)})},updateMask:{fieldPaths:['searchReady','keywordTokens']},currentDocument:{updateTime:raw.updateTime}});
  }
  await updateJob(p,{...p.j,status:'ready',searchPublished:true,lexicalVersion:'bigrams_v1'},writes);
 }
 async function publishExisting({documentId}){const p=await load(documentId);if(p.j.status!=='ready')fail('VECTOR_INPUT','只可補登已完成的稿件。',400);await publish(p);return {documentId,published:true};}
 async function run({documentId,planHash,confirmed}){
  if(confirmed!==true||typeof planHash!=='string')fail('VECTOR_INPUT','請先預覽並確認本次向量化。',400);
  const p=await load(documentId);
  if(planHash!==p.planHash)fail('VECTOR_PLAN','稿件或設定已變動，請重新預覽。',409);
  if(p.completed===p.parts.length){await publish(p);return {...summary(p),processedNow:0};}
  if((p.j.leaseUntil||0)>now())fail('VECTOR_BUSY','此稿件正在處理，請稍後重新預覽。',409);
  const owner=randomUUID(),started=now();let processed=0;
  const timestamp=()=>new Date(now()).toISOString();
  await updateJob(p,{...p.j,status:'processing',leaseOwner:owner,leaseUntil:now()+300000,configHash:p.configHash,model:MODEL,dimensions:DIMENSIONS,totalChunks:p.parts.length,completedChunks:p.completed,attempts:(p.j.attempts||0)+1,updatedAt:timestamp(),lastErrorCode:''});
  try{
   while(processed<BATCH_SIZE&&p.completed<p.parts.length&&now()-started<75000){
    if(p.j.leaseOwner!==owner)fail('VECTOR_BUSY','處理權已變動，請重新預覽。',409);
    const index=p.completed,part=p.parts[index],chunkId=documentId+'_'+p.configHash.slice(0,16)+'_'+String(index).padStart(4,'0');
    // Count the attempt before sending; interrupted calls may still incur provider cost.
    await updateJob(p,{...p.j,embeddingRequests:(p.j.embeddingRequests||0)+1,updatedAt:timestamp()});
    const text=p.template.replace(/\{\{(title|content)\}\}/g,(_,key)=>key==='title'?p.d.title:part.text);
    const r=await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models/'+MODEL+':embedContent',{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},body:JSON.stringify({model:'models/'+MODEL,content:{parts:[{text}]},outputDimensionality:DIMENSIONS}),signal:AbortSignal.timeout(20000),redirect:'error'});
    if(!r.ok){await r.body?.cancel();fail(r.status===429?'VECTOR_QUOTA':'VECTOR_UPSTREAM','向量模型呼叫未完成，請確認額度與模型權限後手動重試。');}
    const bytes=[];let size=0;for await(const b of r.body){size+=b.length;if(size>200000)fail('VECTOR_RESULT','向量回覆超過上限。');bytes.push(b);}
    let payload;try{payload=JSON.parse(Buffer.concat(bytes).toString('utf8'));}catch{fail('VECTOR_RESULT','向量回覆格式不正確。');}
    const embedding=nativeVector(payload.embedding?.values);
    const fields=firestoreFields({documentId,contentSha256:p.d.contentSha256,configHash:p.configHash,model:MODEL,dimensions:DIMENSIONS,index,start:part.start,end:part.end,text:part.text,title:p.d.title,createdAt:timestamp(),recordType:testOnly?'system_test':'knowledge',searchReady:false});fields.embedding=embedding;
    const complete=index+1===p.parts.length;
    await updateJob(p,{...p.j,completedChunks:index+1,status:complete?'ready':'processing',updatedAt:timestamp()},[{update:{name:name(chunksCollection,chunkId),fields},currentDocument:{exists:false}}]);
    processed++;
   }
   await updateJob(p,{...p.j,status:p.completed===p.parts.length?'ready':'partial',leaseOwner:'',leaseUntil:0,updatedAt:timestamp()});
   if(p.completed===p.parts.length)await publish(p);
   return {...summary(p),processedNow:processed};
  }catch(error){
   // A lost commit response is reconciled by reading durable progress; never rewind it.
   try{const raw=await api(FIRESTORE_ROOT+'/'+jobs+'/'+documentId);const j=decode(raw);if(j.leaseOwner===owner){p.job=raw;p.j=j;await updateJob(p,{...j,status:j.completedChunks===p.parts.length?'ready':'failed',leaseOwner:'',leaseUntil:0,lastErrorCode:error instanceof VectorError?error.code:'VECTOR_STORAGE',updatedAt:timestamp()});}}catch{}
   if(error instanceof VectorError)throw error;fail('VECTOR_RETRY','處理中斷，已完成段落會保留。請重新預覽後手動繼續；未存妥的模型回覆可能需要重新計費。');
  }
 }
 return {list,preview,run,publishExisting};
}
