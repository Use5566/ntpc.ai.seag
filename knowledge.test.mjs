import test from 'node:test';
import assert from 'node:assert/strict';
import {makeRecord,recordInput} from './storage.mjs';
import {persistKnowledge,FIRESTORE_ROOT,fromFirestore} from './firestore.mjs';
import {readCurrentDocument,isCurrent,revisionPlan} from './revisions.mjs';
import {createVectorizer} from './vectorize.mjs';
import {createChat} from './chat.mjs';
import {partialDate,bodySections,remapSections,validateSourceMap,layeredText} from './knowledge.js';
import {keywordTokens,queryTokens,fuseResults} from './hybrid.mjs';
const fail=(code,message,status=503)=>{throw Object.assign(Error(message),{code,status});};
const source='以甲乙比較題引導學生提出證據。原稿也提醒：單一案例不可推論所有學生。';
export const v2Input={title:'評量測試',body:'以甲乙比較題引導學生提出證據。',metadata:{eventDate:'2026-10',contentType:'研習整理稿',topics:['評量'],summary:'比較題。',limitations:[],domains:['自然科學'],gradeBands:['國小中年級'],usageLicense:'internal_knowledge',visibility:'token_holders',schemaVersion:'seag_metadata_v2'},sourceCount:1,confirmed:true,sourceConfirmed:true,sources:[{id:'P001',text:source}],sourceMap:[{sectionId:'S001',sourceIds:['P001'],kind:'source'}],lineage:{documentId:'DOC-11111111-1111-4111-8111-111111111111',version:1,previousRecordId:'',changeNote:'初次建立'}};
const decode=raw=>fromFirestore({mapValue:{fields:raw.fields}});
function database(){
 const docs=new Map();let serial=0,embeddingCalls=0,answerCalls=0,loseReply=false;const queries=[];
 const api=async(url,options={})=>{
  if(url.endsWith(':commit')){
   const writes=options.json.writes;
   for(const w of writes){const old=docs.get(w.update.name);if(w.currentDocument?.exists===false&&old)throw Error('already exists');if(w.currentDocument?.updateTime&&old?.updateTime!==w.currentDocument.updateTime)throw Error('CAS conflict');}
   for(const w of writes){const fields=w.updateMask?{...docs.get(w.update.name).fields,...w.update.fields}:w.update.fields;docs.set(w.update.name,{name:w.update.name,fields:structuredClone(fields),updateTime:String(++serial)});}
   if(loseReply){loseReply=false;throw Error('lost reply');}return {};
  }
  if(url.endsWith(':runQuery')){
   const q=options.json.structuredQuery;queries.push(q);let rows=[...docs.values()].filter(d=>d.name.includes('/'+q.from[0].collectionId+'/'));
   for(const f of q.where.compositeFilter.filters){const {field,op,value}=f.fieldFilter;rows=rows.filter(d=>{const v=d.fields[field.fieldPath];if(!v)return false;return op==='ARRAY_CONTAINS_ANY'?value.arrayValue.values.some(t=>v.arrayValue.values.some(x=>x.stringValue===t.stringValue)):JSON.stringify(v)===JSON.stringify(value);});}
   return rows.slice(0,q.limit||q.findNearest.limit).map(document=>({document:structuredClone(document)}));
  }
  const name=url.replace('https://firestore.googleapis.com/v1/','');const d=docs.get(name);if(!d&&!options.allow404)throw Error('missing '+name);return d?structuredClone(d):null;
 };
 const fetchImpl=async(url,options)=>{
  if(url.endsWith(':embedContent')){embeddingCalls++;return new Response(JSON.stringify({embedding:{values:Array(1536).fill(1)}}));}
  answerCalls++;const payload=JSON.parse(options.body),input=JSON.parse(payload.contents[0].parts[0].text);assert.ok(!JSON.stringify(input).includes('單一案例不可推論所有學生'),'底稿不得偷偷加入問答');
  return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({answer:'以比較题引導證據 [S1]。'.replace('题','題'),sourceIds:['S1']})}]}}]}));
 };
 const save=async(input)=>{const record=makeRecord(input);await persistKnowledge({api,record,fileId:'test-file',submittedAt:'2026-10-05T00:00:00Z',toolVersion:'0.9.0',fail});return record;};
 return {api,docs,save,fetchImpl,queries,get embeddingCalls(){return embeddingCalls;},get answerCalls(){return answerCalls;},loseNextReply(){loseReply=true;}};
}
test('核心日期允許未知精度；無效日期與 metadata 授權拒絕',()=>{
 for(const d of ['','2026','2026-02','2024-02-29'])assert.ok(partialDate(d));
 for(const d of ['2026-13','2025-02-29','2026-00','日期不明'])assert.equal(partialDate(d),false);
 const r=makeRecord(v2Input);assert.deepEqual(makeRecord(recordInput(r.document)),r);assert.ok(r.filename.includes('_v1_'));assert.ok(layeredText(r.document).includes(source));
 for(const m of [{usageLicense:''},{visibility:'public'},{domains:['x'.repeat(121)]},{hostOrganization:'禁止'}])assert.throws(()=>makeRecord({...v2Input,metadata:{...v2Input.metadata,...m}}));
});
test('兩層內容和完整對照不可遺漏；禁止底稿含憑證或識別欄位',()=>{
 for(const update of [{sourceConfirmed:false},{sources:[]},{sourceMap:[]},{sourceMap:[{sectionId:'S001',sourceIds:['P999'],kind:'source'}]},{sources:[{id:'P001',text:'hostOrganization: 不可保存'}]},{sources:[{id:'P001',text:'AIza'+'x'.repeat(35)}]}])assert.throws(()=>makeRecord({...v2Input,...update}));
 const changed=makeRecord({...v2Input,sources:[{id:'P001',text:source+'補充'}]});assert.notEqual(changed.digest,makeRecord(v2Input).digest);
});
test('正文編輯會使變動段落對照失效；重排未變段落仍保留来源'.replace('来源','來源'),()=>{
 const old='第一段。\n\n第二段。',map=[{sectionId:'S001',sourceIds:['P001'],kind:'source'},{sectionId:'S002',sourceIds:['P002'],kind:'source'}];
 const reordered=remapSections(old,'第二段。\n\n第一段。',map);assert.deepEqual(reordered[0].sourceIds,['P002']);
 const changed=remapSections(old,'修改了。\n\n第二段。',map);assert.deepEqual(changed[0].sourceIds,[]);assert.throws(()=>validateSourceMap('修改了。\n\n第二段。',changed,[{id:'P001'},{id:'P002'}]));
 assert.deepEqual(bodySections('甲😀\n\n乙').map(x=>[x.start,x.end]),[[0,2],[4,5]]);
});
test('版本原子更新、重試不回退、舊版退出搜尋且仍保留底稿',async()=>{
 const db=database(),r1=await db.save(v2Input),vector=createVectorizer({api:db.api,fetchImpl:db.fetchImpl});
 const plan=await vector.preview({documentId:r1.id});await vector.run({...plan,confirmed:true});const calls=db.embeddingCalls;
 const next={...v2Input,body:'修訂：先設定目標再命題。',lineage:{...v2Input.lineage,version:2,previousRecordId:r1.id,changeNote:'修訂原則'}};
 const r2=await db.save(next);assert.equal(db.embeddingCalls,calls,'儲存版本不能自動向量化');
 assert.equal(await isCurrent(db.api,{...r1.document,recordId:r1.id}),false);
 assert.equal(await isCurrent(db.api,{...r2.document,recordId:r2.id}),true);
 assert.ok([...db.docs.values()].filter(d=>d.name.includes('/chunks/')).every(d=>d.fields.searchReady.booleanValue===false));
 await db.save(v2Input);assert.equal(await isCurrent(db.api,{...r2.document,recordId:r2.id}),true);
 const loaded=await readCurrentDocument(db.api,r1.id,fail);assert.equal(loaded.recordId,r2.id);assert.deepEqual(loaded.sources,v2Input.sources);
 await assert.rejects(vector.preview({documentId:r1.id}),/取代/);
 await assert.rejects(db.save({...next,body:'另一份修改'}),/版本/);
 const chat=createChat({api:db.api,fetchImpl:db.fetchImpl});assert.equal((await chat.ask({question:'命題原則',history:[]})).sources.length,0);
 const p2=await vector.preview({documentId:r2.id});await vector.run({...p2,confirmed:true});
 const result=await chat.ask({question:'命題原則',history:[]});assert.equal(result.sources[0].version,2);assert.deepEqual(result.sources[0].sourceIds,['P001']);
 assert.ok(db.queries.some(q=>q.findNearest));assert.ok(db.queries.some(q=>q.where.compositeFilter.filters.some(f=>f.fieldFilter.op==='ARRAY_CONTAINS_ANY')));
});
test('同時建立同文件版本只允許一個提交；回覆遺失可重送',async()=>{
 const db=database(),a=makeRecord(v2Input),b=makeRecord({...v2Input,body:'另一份內容'});
 const [pa,pb]=await Promise.all([revisionPlan(db.api,a,fail),revisionPlan(db.api,b,fail)]);
 await db.api(FIRESTORE_ROOT+':commit',{json:{writes:pa.writes}});await assert.rejects(db.api(FIRESTORE_ROOT+':commit',{json:{writes:pb.writes}}));
 const fresh=database();fresh.loseNextReply();await assert.rejects(fresh.save(v2Input));const recovered=await fresh.save(v2Input);assert.equal(recovered.id,a.id);assert.equal(fresh.docs.size,3);
});
test('混合搜尋中文雙字與課綱代碼可命中；融合去重不全量掃描',()=>{
 assert.deepEqual(queryTokens('ＡＢＣ-123'),keywordTokens('abc-123'));assert.ok(keywordTokens('素養導向評量').some(t=>queryTokens('評量').includes(t)));assert.equal(queryTokens('測試'.repeat(100)).length<=30,true);
 const row=(name,text)=>({name,fields:{title:{stringValue:''},text:{stringValue:text}}});const a=row('a','其他內容'),b=row('b','ABC-123 評量');
 const result=fuseResults([a,b],[b],'ABC-123 評量');assert.equal(result[0].name,'b');assert.equal(result.length,2);
});
