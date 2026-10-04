import test from 'node:test';import assert from 'node:assert/strict';
import {createVectorizer,splitText,nativeVector,DIMENSIONS} from './vectorize.mjs';
import {makeRecord} from './storage.mjs';import {FIRESTORE_ROOT,firestoreFields,fromFirestore} from './firestore.mjs';
const input={title:'分段測試',body:'觀察證據。'.repeat(1600),metadata:{eventDate:'',contentType:'整理稿',topics:[],summary:'',limitations:[]},sourceCount:1,confirmed:true};
const record=makeRecord(input),prefix=FIRESTORE_ROOT.slice('https://firestore.googleapis.com/v1/'.length);
function setup(){
 let clock=0;const state={docs:new Map(),calls:0,failAt:0,loseCommit:false,invalid:false};
 const add=(collection,id,value)=>{const name=prefix+'/'+collection+'/'+id;state.docs.set(name,{name,fields:firestoreFields(value),updateTime:'v'+(++clock)});};
 add('documents',record.id,{...record.document,recordId:record.id,contentSha256:record.digest,humanConfirmed:true,recordType:'knowledge'});
 add('ingestionJobs',record.id,{documentId:record.id,contentSha256:record.digest,status:'awaiting_vectorization',attempts:0});
 const api=async(url,options={})=>{
  if(url.endsWith(':commit')){
   const writes=options.json.writes;
   for(const w of writes){const old=state.docs.get(w.update.name);if(w.currentDocument.exists===false&&old)throw Error('exists');if(w.currentDocument.updateTime&&old?.updateTime!==w.currentDocument.updateTime)throw Error('conflict');}
   for(const w of writes)state.docs.set(w.update.name,{...structuredClone(w.update),updateTime:'v'+(++clock)});
   if(state.loseCommit&&writes.length===2){state.loseCommit=false;throw Error('lost reply');}
   return {};
  }
  if(url.includes('?')){return {documents:[structuredClone(state.docs.get(prefix+'/ingestionJobs/'+record.id))]};}
  const doc=state.docs.get(url.slice('https://firestore.googleapis.com/v1/'.length));return doc?structuredClone(doc):null;
 };
 const fetchImpl=async(url,options)=>{state.calls++;assert.ok(url.endsWith('gemini-embedding-2:embedContent'));assert.equal(options.headers['x-goog-api-key'],'fake-key');const b=JSON.parse(options.body);assert.equal(b.outputDimensionality,1536);assert.equal(b.taskType,undefined);assert.ok(b.content.parts[0].text.startsWith('title: 分段測試 | text: '));if(state.calls===state.failAt)return new Response('private provider error',{status:429});return new Response(JSON.stringify({embedding:{values:Array(state.invalid?2:DIMENSIONS).fill(0.5)}}));};
 const vector=createVectorizer({api,env:{GEMINI_API_KEY:'fake-key'},fetchImpl,readFileImpl:async()=> 'title: {{title}} | text: {{content}}',now:()=>1000});
 return {state,vector,api};
}
test('分段完整覆蓋 Unicode 原文，保留重疊及位置',()=>{const text=('測試😀第一段。\n\n第二段。').repeat(700),chars=[...text],parts=splitText(text);let recovered='',end=0;for(const p of parts){assert.ok(p.end-p.start<=1800);assert.ok(p.start<=end);assert.equal(p.text,chars.slice(p.start,p.end).join(''));recovered+=chars.slice(end,p.end).join('');end=p.end;}assert.equal(recovered,text);assert.equal(parts.at(-1).end,chars.length);});
test('查詢和預覽不呼叫 Embedding；未確認不執行',async()=>{const {vector,state}=setup();await vector.list();const p=await vector.preview({documentId:record.id});assert.ok(p.totalChunks>3);assert.equal(state.calls,0);await assert.rejects(vector.run({documentId:record.id,planHash:p.planHash,confirmed:false}),{code:'VECTOR_INPUT'});assert.equal(state.calls,0);});
test('每次最多三段；必須手動續跑；完成重送不再次計費',async()=>{const {vector,state}=setup();const p=await vector.preview({documentId:record.id});const req={documentId:record.id,planHash:p.planHash,confirmed:true};let r=await vector.run(req);assert.equal(r.processedNow,3);assert.equal(r.status,'partial');assert.equal(state.calls,3);while(r.remainingChunks)r=await vector.run(req);assert.equal(r.status,'ready');const n=state.calls;assert.equal((await vector.run(req)).processedNow,0);assert.equal(state.calls,n);assert.equal([...state.docs.keys()].filter(x=>x.includes('/chunks/')).length,p.totalChunks);});
test('部分失敗只重試尚未完成的段落',async()=>{const {vector,state}=setup();const p=await vector.preview({documentId:record.id});state.failAt=2;await assert.rejects(vector.run({documentId:record.id,planHash:p.planHash,confirmed:true}),{code:'VECTOR_QUOTA'});const next=await vector.preview({documentId:record.id});assert.equal(next.completedChunks,1);assert.equal(next.status,'failed');await vector.run({documentId:record.id,planHash:p.planHash,confirmed:true});assert.equal((await vector.preview({documentId:record.id})).completedChunks,4);});
test('提交成功但回覆遺失，從已保存的進度繼續',async()=>{const {vector,state}=setup();const p=await vector.preview({documentId:record.id});state.loseCommit=true;const req={documentId:record.id,planHash:p.planHash,confirmed:true};await assert.rejects(vector.run(req),{code:'VECTOR_RETRY'});assert.equal((await vector.preview({documentId:record.id})).completedChunks,1);await vector.run(req);assert.equal(state.calls,4);});
test('競爭更新只能一個工作取得處理權',async()=>{const {vector,state}=setup();const p=await vector.preview({documentId:record.id}),req={documentId:record.id,planHash:p.planHash,confirmed:true};const results=await Promise.allSettled([vector.run(req),vector.run(req)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(state.calls,3);});
test('竄改稿件、過期計畫、設定變更均不呼叫模型',async()=>{const {vector,state}=setup();const p=await vector.preview({documentId:record.id});await assert.rejects(vector.run({documentId:record.id,planHash:'stale',confirmed:true}),{code:'VECTOR_PLAN'});state.docs.get(prefix+'/documents/'+record.id).fields.body={stringValue:'改稿'};await assert.rejects(vector.preview({documentId:record.id}),{code:'VECTOR_INTEGRITY'});assert.equal(state.calls,0);});
test('拒絕錯誤向量及非有限值，失敗不寫入 chunk',async()=>{for(const v of [[],Array(DIMENSIONS).fill(0),Array(DIMENSIONS).fill(NaN)])assert.throws(()=>nativeVector(v));const {state,vector}=setup();state.invalid=true;const p=await vector.preview({documentId:record.id});await assert.rejects(vector.run({documentId:record.id,planHash:p.planHash,confirmed:true}),{code:'VECTOR_RESULT'});assert.equal([...state.docs.keys()].filter(x=>x.includes('/chunks/')).length,0);});
test('系統測試稿不能由正式管理路徑處理',async()=>{const {state,vector}=setup();state.docs.get(prefix+'/documents/'+record.id).fields.recordType={stringValue:'system_test'};await assert.rejects(vector.preview({documentId:record.id}),{code:'VECTOR_INPUT'});assert.equal(state.calls,0);});
test('設定版本變動拒絕混用向量；未過期的鎖拒絕重複計費',async()=>{const {state,vector}=setup();const p=await vector.preview({documentId:record.id}),j=state.docs.get(prefix+'/ingestionJobs/'+record.id);j.fields.configHash={stringValue:'different'};await assert.rejects(vector.preview({documentId:record.id}),{code:'VECTOR_VERSION'});delete j.fields.configHash;j.fields.leaseUntil={integerValue:'999999'};await assert.rejects(vector.run({documentId:record.id,planHash:p.planHash,confirmed:true}),{code:'VECTOR_BUSY'});assert.equal(state.calls,0);});
