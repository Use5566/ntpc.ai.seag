// Explicit isolated acceptance test; never called by the server or a scheduler.
import assert from 'node:assert/strict';
import {createStorage,VERSION} from './storage.mjs';
import {createVectorizer} from './vectorize.mjs';
import {createChat} from './chat.mjs';
import {FIRESTORE_ROOT,fromFirestore} from './firestore.mjs';
import {isCurrent} from './revisions.mjs';
if(process.argv[2]!=='--run')throw Error('Explicit --run required');
const storage=createStorage(),api=storage.firestoreRequest;
const d={title:'兩層版本混合搜尋驗收',body:'虛構測試代碼 SEAG-QA-927 表示先確認目標，再蒐集證據。',metadata:{eventDate:'2026-10',contentType:'系統測試',topics:['流程驗收'],summary:'虛構內容，不作為正式知識。',limitations:['系統測試，不納入正式知識庫。'],domains:[],gradeBands:[],usageLicense:'internal_knowledge',visibility:'token_holders',schemaVersion:'seag_metadata_v2'},sourceCount:1,confirmed:true,sourceConfirmed:true,sources:[{id:'P001',text:'虛構測試代碼 SEAG-QA-927 表示先確認目標，再蒐集證據。底稿保留這個額外細節：紫色卡片僅為測試道具。'}],sourceMap:[{sectionId:'S001',sourceIds:['P001'],kind:'source'}],lineage:{documentId:'DOC-92709270-1111-4111-8111-222222222222',version:1,previousRecordId:'',changeNote:'系統驗收初版'}};
const first=await storage.save(d,{systemTest:true});
const vector=createVectorizer({api,testOnly:true});
const get=async id=>fromFirestore({mapValue:{fields:(await api(FIRESTORE_ROOT+'/systemChecks/'+id)).fields}});
if(await isCurrent(api,await get(first.recordId),true)){const p=await vector.preview({documentId:first.recordId});await vector.run({...p,confirmed:true});}
const next={...d,body:'虛構測試代碼 SEAG-QA-927 的新版原則：先蒐集證據，再比較不同解釋。',lineage:{...d.lineage,version:2,previousRecordId:first.recordId,changeNote:'系統驗收第二版'}};
const second=await storage.save(next,{systemTest:true});
assert.equal(await isCurrent(api,await get(first.recordId),true),false);
assert.equal(await isCurrent(api,await get(second.recordId),true),true);
const p=await vector.preview({documentId:second.recordId});await vector.run({...p,confirmed:true});
let native=0,lexical=0;
const checked=async(u,o)=>{if(u.endsWith(':runQuery')){if(o.json.structuredQuery.findNearest)native++;else lexical++;}return api(u,o);};
const answer=await createChat({api:checked,testOnly:true}).ask({question:'SEAG-QA-927 的新版原則是什麼？',history:[]});
assert.ok(answer.sources.some(s=>s.documentId===second.recordId));assert.ok(!answer.sources.some(s=>s.documentId===first.recordId));assert.ok(!answer.sources.some(s=>s.text.includes('紫色卡片')));
assert.equal(native,1);assert.equal(lexical,1);
console.log(JSON.stringify({version:VERSION,twoLayers:true,sourceMap:true,versions:[1,2],oldVersionExcluded:true,nativeQueries:native,keywordQueries:lexical,answer:answer.answer,sources:answer.sources.map(s=>({id:s.id,version:s.version,sourceIds:s.sourceIds})),scope:'system_test'}));
