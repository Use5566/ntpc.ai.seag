import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {createStorage,makeRecord,validateSubmission,HEADERS,FOLDER_ID,SPREADSHEET_ID} from './storage.mjs';
const privateKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
const input={title:'自然科評量',body:'以觀察與證據說明作為評量依據。',metadata:{eventDate:'2026-10-04',contentType:'研習整理稿',topics:['自然科'],summary:'評量設計。',limitations:[]},sourceCount:2,confirmed:true};
const json=x=>new Response(JSON.stringify(x));
function mock(){
 const state={rows:[HEADERS],files:new Map(),creates:0,appends:0,failUploadReply:false,failComplete:false,folderShared:true,header:HEADERS,empty:false};
 const fetchImpl=async(url,options={})=>{
  const u=new URL(url);const method=options.method||'GET';
  if(u.hostname==='oauth2.googleapis.com'){const claims=JSON.parse(Buffer.from(options.body.get('assertion').split('.')[1],'base64url'));assert.equal(claims.aud,'https://oauth2.googleapis.com/token');assert.equal(claims.sub,undefined);return json({access_token:'mock-access',expires_in:3600});}
  assert.equal(options.headers.Authorization,'Bearer mock-access');
  assert.ok(!String(options.body).includes(privateKey));
  if(u.pathname.endsWith('/files/'+FOLDER_ID))return json({id:FOLDER_ID,mimeType:'application/vnd.google-apps.folder',driveId:state.folderShared?'shared':undefined,capabilities:{canAddChildren:true}});
  if(u.hostname==='sheets.googleapis.com'){
   if(!u.pathname.includes('/values/'))return json({sheets:[{properties:{sheetId:0,title:'匯入紀錄',gridProperties:{rowCount:1000,columnCount:26}}}]});
   const range=decodeURIComponent(u.pathname.split('/values/')[1]);
   if(range.endsWith(':append')){assert.equal(u.searchParams.get('valueInputOption'),'RAW');state.rows.push(JSON.parse(options.body).values[0]);state.appends++;return json({updates:{updatedRange:`'匯入紀錄'!A${state.rows.length}:U${state.rows.length}`}});}
   const [,start,col,end]=range.match(/!A(\d+):([A-Z]+)(\d+)$/)||[];assert.ok(start,range);
   if(method==='PUT'){assert.equal(u.searchParams.get('valueInputOption'),'RAW');const row=JSON.parse(options.body).values[0];if(state.failComplete&&row[17]==='已儲存'){state.failComplete=false;throw Error('模擬回覆中斷');}state.rows[Number(start)-1]=row;return json({updatedCells:21});}
   if(Number(start)===1&&Number(end)===1)return json({values:[state.header]});
   return json({values:state.rows.slice(Number(start)-1,Number(end)).map(row=>col==='A'?[row[0]]:row)});
  }
  if(u.pathname.endsWith('/generateIds'))return json({ids:['file_'+(state.creates+1)]});
  if(u.pathname==='/upload/drive/v3/files'){
   assert.equal(u.searchParams.get('supportsAllDrives'),'true');const parts=options.body.split('\r\n\r\n');const metadata=JSON.parse(parts[1].split('\r\n--')[0]);const txt=parts[2].split('\r\n--')[0];
   state.creates++;state.files.set(metadata.id,{id:metadata.id,name:metadata.name,parents:metadata.parents,trashed:false,md5Checksum:createHash('md5').update(txt).digest('hex')});
   if(state.failUploadReply){state.failUploadReply=false;throw Error('Google 已建立檔案，但連線中斷');}
   return json({id:metadata.id});
  }
  const id=u.pathname.split('/').at(-1);return state.files.has(id)?json(state.files.get(id)):new Response('{}',{status:404});
 };
 const storage=createStorage({readFileImpl:async()=>JSON.stringify({type:'service_account',client_email:'test@example.iam.gserviceaccount.com',private_key:privateKey,token_uri:'https://invalid.example'}),fetchImpl,now:()=>new Date('2026-10-04T00:00:00Z')});
 return {state,storage};
}
test('正式稿不接受原稿、禁止身分欄位、未確認或超長儲存欄位',()=>{
 for(const data of [{...input,source:[]},{...input,confirmed:false},{...input,metadata:{...input.metadata,hostOrganization:'單位'}},{...input,body:'-----BEGIN PRIVATE KEY-----'},{...input,metadata:{...input.metadata,summary:'x'.repeat(20001)}}])assert.throws(()=>validateSubmission(data));
});
test('相同內容的指紋穩定；修改正文建立不同紀錄；檔名不含路徑',()=>{assert.equal(makeRecord(input).id,makeRecord({...input,metadata:{limitations:[],summary:'評量設計。',topics:['自然科'],contentType:'研習整理稿',eventDate:'2026-10-04'}}).id);assert.notEqual(makeRecord(input).id,makeRecord({...input,body:'新內容'}).id);assert.ok(!/[\\/:]/.test(makeRecord({...input,title:'a/b:c'}).filename));});
test('TXT 和索引均完成才成功；相同稿件重送不重複建立',async()=>{const {state,storage}=mock();const a=await storage.save(input);const b=await storage.save(input);assert.equal(a.recordId,b.recordId);assert.equal(b.reused,true);assert.equal(state.creates,1);assert.equal(state.appends,1);assert.equal(state.rows[1][17],'已儲存');assert.equal(state.rows[1][20],'正式資料');assert.equal(state.rows[1][1],'2026-10-04T08:00:00.000+08:00');});
test('上傳成功但回覆遺失，重送沿用原檔案 ID',async()=>{const {state,storage}=mock();state.failUploadReply=true;await assert.rejects(storage.save(input));assert.equal(state.rows[1][17],'待重試');const a=await storage.save(input);assert.equal(state.creates,1);assert.equal(state.appends,1);assert.equal(a.fileUrl,'https://drive.google.com/file/d/file_1/view');});
test('試算表完成回覆失敗可修復，不能假報已存妥',async()=>{const {state,storage}=mock();state.failComplete=true;await assert.rejects(storage.save(input));assert.equal(state.rows[1][17],'待重試');await storage.save(input);assert.equal(state.creates,1);assert.equal(state.rows[1][17],'已儲存');});
test('拒絕非共用雲端硬碟、欄位變動及被竄改檔案',async()=>{const {state,storage}=mock();state.folderShared=false;await assert.rejects(storage.save(input),{code:'STORAGE_FOLDER'});state.folderShared=true;state.header=['其他欄位'];await assert.rejects(storage.save(input),{code:'STORAGE_SCHEMA'});assert.equal(state.creates,0);state.header=HEADERS;await storage.save(input);state.files.get('file_1').md5Checksum='tampered';await assert.rejects(storage.save(input),{code:'STORAGE_INTEGRITY'});});
test('以 RAW 寫入，試算表不執行使用者文字公式',async()=>{const {state,storage}=mock();await storage.save({...input,title:'=IMPORTXML("https://example.com","//a")'});assert.ok(state.rows[1][2].startsWith('=IMPORTXML'));});
test('單一程序同時送出不重複寫入；系統測試有獨立標記',async()=>{const {storage,state}=mock();const first=storage.save(input,{systemTest:true});await assert.rejects(storage.save(input),{code:'STORAGE_BUSY'});await first;assert.equal(state.rows[1][20],'系統測試');});
test('憑證缺失時安全失敗，不回傳私密金鑰或原始錯誤',async()=>{const storage=createStorage({readFileImpl:async()=>{throw Error('PRIVATE SECRET');}});await assert.rejects(storage.save(input),e=>e.code==='STORAGE_CONFIG'&&!e.message.includes('PRIVATE SECRET'));});
