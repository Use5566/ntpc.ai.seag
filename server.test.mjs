import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from './server.mjs';
import {validateSubmission} from './storage.mjs';
const token='test-only-access-'.repeat(3),key='fake-upstream-credential';
const origin='https://use5566.github.io';
const input={mode:'analyze',title:'觀察',source:[{id:'P001',text:'觀察並記錄日期。'}]};
const result={title:'觀察',body:'觀察並記錄日期。',metadata:{eventDate:'',contentType:'整理稿',topics:[],summary:'',limitations:[]},omissions:[],questions:[],privacyCandidates:[],coverage:[{sourceId:'P001',status:'retained',target:'觀察'}]};
const reply=value=>new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]}));
async function setup(t,fetchImpl=async()=>reply(result),extra={}){
 const server=await createApp({env:{GEMINI_API_KEY:key,SEAG_ACCESS_TOKEN:token,...extra},fetchImpl});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const base=`http://127.0.0.1:${server.address().port}`;
 return {base,request:(body=input,headers={})=>fetch(base+'/api/organize',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Authorization:`Bearer ${token}`,...headers},body:JSON.stringify(body)})};
}
test('未設定獨立存取碼時拒絕啟動',async()=>{await assert.rejects(createApp({env:{GEMINI_API_KEY:key}}));await assert.rejects(createApp({env:{GEMINI_API_KEY:token,SEAG_ACCESS_TOKEN:token}}));});
test('驗證存取碼與來源，未授權不呼叫模型',async t=>{let calls=0;const app=await setup(t,async()=>{calls++;return reply(result);});assert.equal((await app.request(input,{Authorization:'Bearer bad'})).status,401);assert.equal((await app.request(input,{Origin:'https://evil.example'})).status,403);assert.equal(calls,0);});
test('金鑰只置於 Google header；模型固定；提示詞在伺服器讀取',async t=>{const app=await setup(t,async(url,options)=>{assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');assert.equal(options.headers['x-goog-api-key'],key);assert.ok(!options.body.includes(key));assert.ok(JSON.parse(options.body).systemInstruction.parts[0].text.includes('metadata'));return reply(result);});const res=await app.request();assert.equal(res.status,200);assert.deepEqual(await res.json(),{result});assert.equal(res.headers.get('cache-control'),'no-store');});
test('後端不提供檔案或環境變數',async t=>{const {base}=await setup(t);for(const path of ['/.env','/server.mjs','/api-config.js','/prompt-system.txt'])assert.equal((await fetch(base+path)).status,404);assert.deepEqual(await (await fetch(base+'/health')).json(),{ok:true,version:'0.5.0'});});
test('上游錯誤不回傳秘密或逐字稿',async t=>{const app=await setup(t,async()=>new Response(key+token+input.source[0].text,{status:403}));const res=await app.request();const body=await res.text();assert.equal(res.status,502);for(const secret of [key,token,input.source[0].text])assert.ok(!body.includes(secret));});
test('拒絕未齊全或含憑證的 AI 結果',async t=>{let n=0;const app=await setup(t,async()=>reply(n++?{...result,body:key}:{...result,coverage:[]}));assert.equal((await app.request()).status,502);assert.equal((await app.request()).status,502);});
test('拒絕禁止欄位、超長來源及自訂模型提示詞',async t=>{const app=await setup(t,async()=>{assert.fail('不可呼叫模型');});assert.equal((await app.request({...input,model:'other'})).status,400);assert.equal((await app.request({...input,source:[{id:'P001',text:'x'.repeat(100001)}]})).status,413);assert.equal((await app.request({...input,metadataHints:{hostOrganization:'X'}})).status,400);});
test('共用使用上限不可藉不同 IP 規避',async t=>{const app=await setup(t,undefined,{MAX_REQUESTS_PER_HOUR:'1'});assert.equal((await app.request()).status,200);assert.equal((await app.request(input,{'X-Forwarded-For':'1.2.3.4'})).status,429);});
test('修訂必須處理所有問題',async t=>{const app=await setup(t);const draft={...result,questions:[{id:'Q001',sourceIds:['P001'],question:'日期？',context:'未確認'}]};const body={...input,mode:'revise',currentDraft:draft,editorDecisions:{},previousDecisions:[]};assert.equal((await app.request(body)).status,400);body.editorDecisions={Q001:{action:'unknown',text:''}};assert.equal((await app.request(body)).status,200);});

test('雲端儲存 API 必須通過來源、存取碼與正式稿格式檢查',async t=>{
 let saves=0;const server=await createApp({env:{GEMINI_API_KEY:key,SEAG_ACCESS_TOKEN:token},fetchImpl:async()=>assert.fail('儲存不能呼叫 Gemini'),storageImpl:{save:async body=>{validateSubmission(body);saves++;return {recordId:'test'};}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const url=`http://127.0.0.1:${server.address().port}/api/archive`;
 const post=(body,headers={})=>fetch(url,{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${token}`,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 const doc={title:result.title,body:result.body,metadata:result.metadata,sourceCount:1,confirmed:true};
 assert.equal((await post(doc,{Authorization:'Bearer wrong'})).status,401);assert.equal((await post(doc,{Origin:'https://other.example'})).status,403);assert.equal(saves,0);
 assert.equal((await post({...doc,source:input.source})).status,400);assert.equal((await post({...doc,body:key})).status,400);assert.equal((await post({...doc,confirmed:false})).status,400);
 const r=await post(doc);assert.equal(r.status,200);assert.equal(saves,1);assert.equal(r.headers.get('access-control-allow-origin'),origin);
});
