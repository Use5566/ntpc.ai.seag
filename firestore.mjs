// Server-only Firestore persistence. The browser cannot select the destination.
export const FIRESTORE_PROJECT='ntpc-ai-seag';
export const FIRESTORE_DATABASE='(default)';
const root=`projects/${FIRESTORE_PROJECT}/databases/${FIRESTORE_DATABASE}/documents`;
export const FIRESTORE_ROOT='https://firestore.googleapis.com/v1/'+root;
export function firestoreValue(value){
 if(typeof value==='string')return {stringValue:value};
 if(typeof value==='boolean')return {booleanValue:value};
 if(Number.isSafeInteger(value))return {integerValue:String(value)};
 if(Array.isArray(value))return {arrayValue:{values:value.map(firestoreValue)}};
 if(value&&typeof value==='object')return {mapValue:{fields:firestoreFields(value)}};
 throw Error('Unsupported Firestore value');
}
export const firestoreFields=value=>Object.fromEntries(Object.entries(value).map(([k,v])=>[k,firestoreValue(v)]));
export function fromFirestore(value){
 if('stringValue'in value)return value.stringValue;
 if('booleanValue'in value)return value.booleanValue;
 if('integerValue'in value)return Number(value.integerValue);
 if('arrayValue'in value)return (value.arrayValue.values||[]).map(fromFirestore);
 if('mapValue'in value)return Object.fromEntries(Object.entries(value.mapValue.fields||{}).map(([k,v])=>[k,fromFirestore(v)]));
 throw Error('Unexpected Firestore value');
}
const stable=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
export async function persistKnowledge({api,record,fileId,submittedAt,toolVersion,fail,testOnly=false}){
 const d=record.document;
 const collection=testOnly?'systemChecks':'documents',jobs=testOnly?'systemCheckJobs':'ingestionJobs';
 const result={status:testOnly?'excluded_system_test':'stored',recordId:record.id};
 const document={schemaVersion:'seag_document_v1',recordId:record.id,contentSha256:record.digest,title:d.title,body:d.body,metadata:d.metadata,sourceCount:d.sourceCount,format:d.format,driveFileId:fileId,createdAt:submittedAt,toolVersion,humanConfirmed:true,recordType:testOnly?'system_test':'knowledge'};
 const url=FIRESTORE_ROOT+'/'+collection+'/'+record.id;
 const existing=await api(url,{allow404:true});
 if(existing){
  // Verify the immutable source payload, but preserve subsequent processing state.
  const decoded=fromFirestore({mapValue:{fields:existing.fields||{}}});
  const keys=Object.keys(document).filter(k=>k!=='toolVersion');
  if(keys.some(k=>stable(decoded[k])!==stable(document[k])))fail('STORAGE_FIRESTORE_INTEGRITY','Firestore 正式稿與本次內容不一致，請管理者檢查；未覆寫既有資料。');
  const job=await api(FIRESTORE_ROOT+'/'+jobs+'/'+record.id,{allow404:true});
  if(job?.fields?.contentSha256?.stringValue!==record.digest)fail('STORAGE_FIRESTORE_INTEGRITY','Firestore 處理紀錄缺失或不一致，請管理者檢查。');
  return result;
 }
 const job={schemaVersion:'seag_ingestion_v1',documentId:record.id,contentSha256:record.digest,status:testOnly?'excluded_system_test':'awaiting_vectorization',attempts:0,createdAt:submittedAt,updatedAt:submittedAt};
 // Atomic create: no partial document/job pair and no overwriting later job progress.
 await api(FIRESTORE_ROOT+':commit',{method:'POST',json:{writes:[
  {update:{name:root+'/'+collection+'/'+record.id,fields:firestoreFields(document)},currentDocument:{exists:false}},
  {update:{name:root+'/'+jobs+'/'+record.id,fields:firestoreFields(job)},currentDocument:{exists:false}}
 ]}});
 const verified=await api(url);
 if(verified.fields?.contentSha256?.stringValue!==record.digest)fail('STORAGE_FIRESTORE_INTEGRITY','Firestore 寫入仍待確認，請重新送出。');
 return result;
}
