// Explicit one-time migration. Does not call an embedding model or run at server startup.
import {createStorage} from './storage.mjs';
import {createVectorizer} from './vectorize.mjs';
import {FIRESTORE_ROOT,fromFirestore} from './firestore.mjs';
const testOnly=process.argv.includes('--system-test');
if(process.argv.slice(2).some(a=>a!=='--system-test'))throw Error('Unsupported argument');
const api=createStorage().firestoreRequest,vector=createVectorizer({api,testOnly});
let page='',published=0,skipped=0;
do{
 const r=await api(FIRESTORE_ROOT+'/'+(testOnly?'systemCheckJobs':'ingestionJobs')+'?pageSize=100'+(page?'&pageToken='+encodeURIComponent(page):''));
 for(const raw of r.documents||[]){const j=fromFirestore({mapValue:{fields:raw.fields}});if(j.status!=='ready'||(j.searchPublished===true&&j.lexicalVersion==='bigrams_v1')){skipped++;continue;}await vector.publishExisting({documentId:j.documentId});published++;}
 page=r.nextPageToken||'';
}while(page);
console.log(JSON.stringify({scope:testOnly?'system_test':'knowledge',published,skipped,embeddingCalls:0}));
