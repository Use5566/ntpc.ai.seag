import {FIRESTORE_ROOT,firestoreFields,fromFirestore} from './firestore.mjs';
const decode=raw=>fromFirestore({mapValue:{fields:raw.fields}});
const names=testOnly=>({heads:testOnly?'systemCheckHeads':'documentHeads',docs:testOnly?'systemChecks':'documents',jobs:testOnly?'systemCheckJobs':'ingestionJobs',chunks:testOnly?'systemCheckChunks':'chunks'});
const idOK=id=>/^SEAG-[a-f0-9]{64}$/.test(id||'');
export async function revisionPlan(api,record,fail,testOnly=false){
 if(record.document.format!=='seag_text_v2')return {writes:[]};
 const n=names(testOnly),l=record.document.lineage,url=FIRESTORE_ROOT+'/'+n.heads+'/'+l.documentId;
 const head=await api(url,{allow404:true}),h=head&&decode(head);
 const existing=await api(FIRESTORE_ROOT+'/'+n.docs+'/'+record.id,{allow404:true});
 // Retrying an immutable old version must never move the head backwards.
 if(existing)return {writes:[]};
 if(l.version===1?(!!h||!!l.previousRecordId):(!h||h.version!==l.version-1||h.recordId!==l.previousRecordId))fail('STORAGE_VERSION_CONFLICT','此文件已新增版本，或前一版本不正確。請重新載入最新版本後再修改；未覆寫現有版本。',409);
 const writes=[];
 if(h){
  const previous=await api(FIRESTORE_ROOT+'/'+n.docs+'/'+h.recordId,{allow404:true});
  const old=previous&&decode(previous);if(!old||old.lineage?.documentId!==l.documentId)fail('STORAGE_VERSION_CONFLICT','前一版本資料不完整。',409);
  const rawJob=await api(FIRESTORE_ROOT+'/'+n.jobs+'/'+h.recordId,{allow404:true});
  const job=rawJob&&decode(rawJob);if(!job)fail('STORAGE_VERSION_CONFLICT','前一版本處理紀錄不完整。',409);
  // CAS on the job prevents an in-flight publisher from reopening obsolete chunks.
  writes.push({update:{name:rawJob.name,fields:firestoreFields({...job,status:'superseded',searchPublished:false,leaseOwner:'',leaseUntil:0})},currentDocument:{updateTime:rawJob.updateTime}});
  for(let i=0;i<(job.completedChunks||0);i++){
   const id=h.recordId+'_'+job.configHash.slice(0,16)+'_'+String(i).padStart(4,'0');
   const chunk=await api(FIRESTORE_ROOT+'/'+n.chunks+'/'+id,{allow404:true});
   if(chunk)writes.push({update:{name:chunk.name,fields:{searchReady:{booleanValue:false}}},updateMask:{fieldPaths:['searchReady']},currentDocument:{updateTime:chunk.updateTime}});
  }
 }
 const name=url.slice('https://firestore.googleapis.com/v1/'.length);
 writes.push({update:{name,fields:firestoreFields({documentId:l.documentId,recordId:record.id,version:l.version,status:'confirmed'})},currentDocument:head?{updateTime:head.updateTime}:{exists:false}});
 return {writes};
}
export async function isCurrent(api,d,testOnly=false){
 if(d.format!=='seag_text_v2')return true;
 const raw=await api(FIRESTORE_ROOT+'/'+names(testOnly).heads+'/'+d.lineage.documentId,{allow404:true});
 const h=raw&&decode(raw);return h?.recordId===d.recordId&&h?.version===d.lineage.version;
}
export async function readCurrentDocument(api,recordId,fail){
 if(!idOK(recordId))fail('STORAGE_INPUT','請輸入有效的版本紀錄編號。',400);
 const raw=await api(FIRESTORE_ROOT+'/documents/'+recordId,{allow404:true});
 if(!raw)fail('STORAGE_MISSING','找不到此正式稿。',404);
 let d=decode(raw);
 if(d.recordType!=='knowledge'||d.humanConfirmed!==true)fail('STORAGE_INPUT','只可載入已確認的正式稿。',400);
 if(d.format!=='seag_text_v2')fail('STORAGE_LEGACY','此舊稿沒有詳細底稿與來源對照，請以新文件重新匯入。',409);
 const h=await api(FIRESTORE_ROOT+'/documentHeads/'+d.lineage.documentId,{allow404:true});
 const head=h&&decode(h);if(!head||!idOK(head.recordId))fail('STORAGE_VERSION_CONFLICT','版本紀錄不完整。',409);
 if(head.recordId!==recordId){const latest=await api(FIRESTORE_ROOT+'/documents/'+head.recordId);d=decode(latest);}
 return {title:d.title,body:d.body,metadata:d.metadata,sources:d.sources,sourceMap:d.sourceMap,lineage:d.lineage,recordId:d.recordId};
}
