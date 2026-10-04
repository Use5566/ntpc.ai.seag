import {readFile} from 'node:fs/promises';
import {createHash,createSign,randomUUID} from 'node:crypto';
import {MAX_CHARS,validDate,privacyIssues,exportText} from './core.js';
import {persistKnowledge} from './firestore.mjs';

export const FOLDER_ID='1_JvYzPgw25KdYCP0fT_ajpm4sdBwHZJe';
export const SPREADSHEET_ID='1lvZLaRW6ULLGXASGBhvIoOOEPsk3nq6iiK0sxUnl77o';
export const SHEET_ID=0;
export const VERSION='0.6.0';
export const COLUMNS=[
 ['紀錄編號','依正式稿內容產生的 SHA-256 編號；相同內容重送使用相同紀錄。'],
 ['送出時間（臺北）','伺服器首次接受送出的時間，時區 UTC+08:00。'],
 ['知識稿標題','提供者檢閱後的中性標題。'],
 ['活動日期','YYYY-MM-DD；未確認時留空。'],
 ['資料類型','例如研習逐字稿；由提供者確認。'],
 ['主題／關鍵詞','以換行分隔。'],
 ['整體摘要','提供者確認後的摘要；不存原始逐字稿。'],
 ['內容限制','不確定事項與使用限制，以換行分隔。'],
 ['來源段落數','只記錄數量，不儲存來源文字。'],
 ['正文字元數','整理正文的 Unicode 字元數。'],
 ['TXT 檔名','活動日期或日期未確認＋中性標題＋紀錄指紋前 12 碼。'],
 ['Drive 檔案 ID','預先保留的檔案 ID，用於中斷後安全重試。'],
 ['TXT 連結','檔案保留指定資料夾原有分享權限，不自動公開。'],
 ['內容 SHA-256','依標題、正文、metadata、來源段落數與格式版本計算。'],
 ['工具版本','送出時使用的後端版本；不宣稱稿件全部由特定模型生成。'],
 ['TXT 格式版本','seag_text_v1。'],
 ['人工確認','提供者已確認正文、metadata 與去識別事項。'],
 ['儲存狀態','處理中／待重試／已儲存；已儲存表示 TXT 和紀錄都完成。'],
 ['完成時間（臺北）','TXT 與紀錄都完成的時間。'],
 ['TXT SHA-256','實際 UTF-8 TXT 檔案的完整性指紋。'],
 ['紀錄類型','正式資料／系統測試；系統測試不應納入知識庫。']
];
export const HEADERS=COLUMNS.map(c=>c[0]);
export class StorageError extends Error{constructor(code,message,status=503){super(message);this.code=code;this.status=status;}}
const fail=(code,message,status)=>{throw new StorageError(code,message,status);};
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const hash=(text,algorithm='sha256')=>createHash(algorithm).update(text).digest('hex');
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const clean=(v,max,required=false)=>typeof v==='string'&&v.length<=max&&(!required||!!v.trim())&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v);
export function validateSubmission(input){
 if(!exact(input,['title','body','metadata','sourceCount','confirmed'])||input.confirmed!==true||!clean(input.title,180,true)||!clean(input.body,MAX_CHARS,true)||!Number.isInteger(input.sourceCount)||input.sourceCount<1||input.sourceCount>3000)fail('STORAGE_INPUT','請確認正式稿、來源段落數與人工確認狀態。',400);
 const m=input.metadata;
 if(!exact(m,['eventDate','contentType','topics','summary','limitations'])||!validDate(m.eventDate)||!clean(m.eventDate,10)||!clean(m.contentType,120,true)||!clean(m.summary,20000)||!['topics','limitations'].every(k=>Array.isArray(m[k])&&m[k].length<=100&&m[k].every(v=>clean(v,2000,true))&&m[k].join('\n').length<=20000))fail('STORAGE_INPUT','Metadata 格式不正確或內容過長。',400);
 if(privacyIssues(JSON.stringify(input)).length||/"(?:private_key|private_key_id|client_secret)"\s*:/i.test(JSON.stringify(input)))fail('STORAGE_INPUT','正式稿含有禁止欄位或疑似憑證，請移除。',400);
 // Explicit projection excludes raw sources, questions, omitted text and identities.
 return {title:input.title.trim(),body:input.body,metadata:{eventDate:m.eventDate,contentType:m.contentType.trim(),topics:[...m.topics],summary:m.summary,limitations:[...m.limitations]},sourceCount:input.sourceCount,format:'seag_text_v1'};
}
export function makeRecord(input){const document=validateSubmission(input);const digest=hash(JSON.stringify(document));return {document,digest,id:'SEAG-'+digest,filename:(document.metadata.eventDate.replaceAll('-','')||'日期未確認')+'_'+(document.title.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').replace(/[. ]+$/g,'').slice(0,50)||'知識整理稿')+'_'+digest.slice(0,12)+'.txt'};}
export const taipeiTime=date=>new Date(new Date(date).getTime()+8*3600000).toISOString().replace('Z','+08:00');

export function createStorage({env=process.env,fetchImpl=fetch,readFileImpl=readFile,now=()=>new Date()}={}){
 let credentials,accessToken,expires=0,locked=false;
 const sheets='https://sheets.googleapis.com/v4/spreadsheets/'+SPREADSHEET_ID;
 const drive='https://www.googleapis.com/drive/v3/files';
 async function token(){
  if(accessToken&&Date.now()<expires)return accessToken;
  try{credentials??=JSON.parse(await readFileImpl(env.GOOGLE_APPLICATION_CREDENTIALS||'/etc/secrets/google-service-account.json','utf8'));if(credentials.type!=='service_account'||!credentials.client_email?.endsWith('.iam.gserviceaccount.com')||!credentials.private_key)throw Error();}catch{fail('STORAGE_CONFIG','Google 儲存憑證尚未就緒，請管理者檢查 Render Secret File。');}
  const b=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const t=Math.floor(Date.now()/1000);
  const p=b({alg:'RS256',typ:'JWT'})+'.'+b({iss:credentials.client_email,scope:'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/datastore',aud:'https://oauth2.googleapis.com/token',iat:t,exp:t+3600});
  let signature;try{signature=createSign('RSA-SHA256').update(p).sign(credentials.private_key,'base64url');}catch{fail('STORAGE_CONFIG','Google 儲存憑證格式不正確。');}
  const r=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:p+'.'+signature}),signal:AbortSignal.timeout(20000)});
  if(!r.ok){await r.body?.cancel();fail('STORAGE_AUTH','Google 儲存授權失敗，請檢查服務帳戶。');}
  const j=await r.json();if(typeof j.access_token!=='string')fail('STORAGE_AUTH','Google 儲存授權失敗。');accessToken=j.access_token;expires=Date.now()+Math.min(Number(j.expires_in)||300,3600)*1000-60000;return accessToken;
 }
 async function api(url,{method='GET',json,body,headers={},allow404=false}={}){
  const r=await fetchImpl(url,{method,headers:{Authorization:'Bearer '+await token(),...(json?{'Content-Type':'application/json'}:{}),...headers},body:json?JSON.stringify(json):body,signal:AbortSignal.timeout(20000),redirect:'error'});
  if(allow404&&r.status===404){await r.body?.cancel();return null;}
  if(!r.ok){await r.body?.cancel();if(r.status===401)expires=0;fail('STORAGE_GOOGLE','Google 儲存未完成。請檢查服務帳戶權限、API 啟用狀態或稍後重試；原稿仍保留。');}
  return r.status===204?{}:r.json();
 }
 async function context(){
  const folder=await api(drive+'/'+FOLDER_ID+'?supportsAllDrives=true&fields=id,mimeType,driveId,capabilities(canAddChildren)');
  if(folder.mimeType!=='application/vnd.google-apps.folder'||!folder.driveId||folder.capabilities?.canAddChildren!==true)fail('STORAGE_FOLDER','目標必須是具有寫入權限的共用雲端硬碟資料夾。');
  const meta=await api(sheets+'?fields=sheets(properties)');const sheet=meta.sheets?.find(s=>s.properties.sheetId===SHEET_ID)?.properties;
  if(!sheet||sheet.gridProperties.columnCount<HEADERS.length)fail('STORAGE_SCHEMA','找不到紀錄工作表，請管理者先完成欄位設定。');
  const range="'"+sheet.title.replaceAll("'","''")+"'!";
  return {folder,sheet,range};
 }
 const values=async range=>(await api(sheets+'/values/'+encodeURIComponent(range)+'?valueRenderOption=UNFORMATTED_VALUE')).values||[];
 const put=async(range,rows)=>api(sheets+'/values/'+encodeURIComponent(range)+'?valueInputOption=RAW',{method:'PUT',json:{values:rows}});
 async function checkHeaders(range){if(JSON.stringify((await values(range+'A1:U1'))[0])!==JSON.stringify(HEADERS))fail('STORAGE_SCHEMA','紀錄表欄位已變動，請管理者核對欄位後再送出。');}
 async function initialize(){
  const {sheet,range}=await context();const existing=await values(range+'A1:U1');
  if(existing.length){await checkHeaders(range);return {alreadyInitialized:true};}
  // Never replace a pre-existing table or hidden content.
  for(let start=1;start<=sheet.gridProperties.rowCount;start+=500){if((await values(range+`A${start}:Z${Math.min(start+499,sheet.gridProperties.rowCount)}`)).some(row=>row.some(v=>v!=='')))fail('STORAGE_SCHEMA','工作表已有內容；未修改，請管理者另行指定空白工作表。');}
  await api(sheets+':batchUpdate',{method:'POST',json:{requests:[
   {updateSheetProperties:{properties:{sheetId:SHEET_ID,title:'匯入紀錄',gridProperties:{frozenRowCount:1}},fields:'title,gridProperties.frozenRowCount'}},
   {updateCells:{range:{sheetId:SHEET_ID,startRowIndex:0,endRowIndex:1,startColumnIndex:0,endColumnIndex:HEADERS.length},rows:[{values:COLUMNS.map(([name,note])=>({userEnteredValue:{stringValue:name},note}))}],fields:'userEnteredValue,note'}},
   {repeatCell:{range:{sheetId:SHEET_ID,startRowIndex:0,endRowIndex:1,startColumnIndex:0,endColumnIndex:HEADERS.length},cell:{userEnteredFormat:{backgroundColor:{red:0.93,green:0.93,blue:0.93},textFormat:{bold:true},wrapStrategy:'WRAP'}},fields:'userEnteredFormat'}},
   {updateDimensionProperties:{range:{sheetId:SHEET_ID,dimension:'COLUMNS',startIndex:0,endIndex:HEADERS.length},properties:{pixelSize:180},fields:'pixelSize'}},
   {updateDimensionProperties:{range:{sheetId:SHEET_ID,dimension:'COLUMNS',startIndex:2,endIndex:3},properties:{pixelSize:280},fields:'pixelSize'}},
   {setBasicFilter:{filter:{range:{sheetId:SHEET_ID,startRowIndex:0,startColumnIndex:0,endColumnIndex:HEADERS.length}}}}
  ]}});
  await checkHeaders("'匯入紀錄'!");return {initialized:true,columns:HEADERS.length};
 }
 async function save(input,{systemTest=false}={}){
  const record=makeRecord(input);
  if(locked)fail('STORAGE_BUSY','目前有儲存工作進行中，請稍後重送。',429);
  locked=true;let reservation;
  try{
   const {sheet,range}=await context();await checkHeaders(range);
   // A single Render instance serializes writers. The durable row is the retry journal.
   for(let start=2;start<=sheet.gridProperties.rowCount;start+=500){const rows=await values(range+`A${start}:A${Math.min(start+499,sheet.gridProperties.rowCount)}`);const index=rows.findIndex(row=>row[0]===record.id);if(index>=0){const rowNumber=start+index;const row=(await values(range+`A${rowNumber}:U${rowNumber}`))[0];reservation={range:range+`A${rowNumber}:U${rowNumber}`,row};break;}}
   if(!reservation){
    const generated=await api(drive+'/generateIds?count=1&space=drive&type=files');const id=generated.ids?.[0];if(!/^[\w-]+$/.test(id||''))fail('STORAGE_GOOGLE','無法建立檔案編號。');
    const submitted=taipeiTime(now());const {document:d}=record;const txt='\uFEFF'+exportText(d,d.sourceCount,submitted);
    const row=[record.id,submitted,d.title,d.metadata.eventDate,d.metadata.contentType,d.metadata.topics.join('\n'),d.metadata.summary,d.metadata.limitations.join('\n'),d.sourceCount,[...d.body].length,record.filename,id,'https://drive.google.com/file/d/'+id+'/view',record.digest,VERSION,d.format,'已確認','處理中','',hash(txt),systemTest?'系統測試':'正式資料'];
    const appended=await api(sheets+'/values/'+encodeURIComponent(range+'A1:U1')+':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',{method:'POST',json:{values:[row]}});
    const updated=appended.updates?.updatedRange;const match=typeof updated==='string'&&updated.match(/!A([1-9]\d*):U([1-9]\d*)$/);if(!match||match[1]!==match[2]||Number(match[1])<2)fail('STORAGE_GOOGLE','紀錄已送出，請重送以確認儲存狀態。');reservation={range:range+'A'+match[1]+':U'+match[1],row};
   }
   const {row}=reservation;const id=row[11];
   if(row[13]!==record.digest||!/^[-\w]+$/.test(id||'')||!/^\d{4}-\d{2}-\d{2}T/.test(row[1]||''))fail('STORAGE_SCHEMA','既有紀錄內容不一致，請管理者檢查。');
   const txt='\uFEFF'+exportText(record.document,record.document.sourceCount,row[1]);
   if(row[19]!==hash(txt))fail('STORAGE_SCHEMA','既有檔案指紋不一致，請管理者檢查。');
   let file=await api(drive+'/'+id+'?supportsAllDrives=true&fields=id,name,parents,trashed,md5Checksum,webViewLink',{allow404:true});
   if(!file){
    const boundary='seag_'+randomUUID();const metadata={id,name:row[10],mimeType:'text/plain',parents:[FOLDER_ID],appProperties:{seagRecordId:record.id,contentSha256:record.digest}};
    const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${txt}\r\n--${boundary}--\r\n`;
    await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id',{method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body});
    file=await api(drive+'/'+id+'?supportsAllDrives=true&fields=id,name,parents,trashed,md5Checksum,webViewLink');
   }
   if(file.trashed||file.name!==row[10]||!file.parents?.includes(FOLDER_ID)||file.md5Checksum!==hash(txt,'md5'))fail('STORAGE_INTEGRITY','TXT 檔案位置或內容與紀錄不一致，請管理者檢查。');
   if(!['正式資料','系統測試'].includes(row[20]))fail('STORAGE_SCHEMA','紀錄類型不正確，請管理者檢查。');
   let firestore={status:'excluded_system_test'};
   {
    try{firestore=await persistKnowledge({api,record,fileId:id,submittedAt:row[1],toolVersion:row[14],fail,testOnly:row[20]==='系統測試'});}
    catch(error){if(error instanceof StorageError&&error.code==='STORAGE_FIRESTORE_INTEGRITY')throw error;fail('STORAGE_FIRESTORE','TXT 已保存，但 Firestore 入庫尚未完成；請重送。系統會沿用相同檔案及紀錄。');}
   }
   const reused=row[17]==='已儲存';row[17]='已儲存';row[18]=row[18]||taipeiTime(now());await put(reservation.range,[row]);
   const verified=(await values(reservation.range))[0];if(verified?.[0]!==record.id||verified?.[17]!=='已儲存')fail('STORAGE_GOOGLE','TXT 已建立，但紀錄仍待確認；請重送。');
   return {recordId:record.id,fileName:row[10],fileUrl:'https://drive.google.com/file/d/'+id+'/view',spreadsheetUrl:'https://docs.google.com/spreadsheets/d/'+SPREADSHEET_ID+'/edit#gid='+SHEET_ID,savedAt:row[18],reused,firestore};
  }catch(error){
   if(reservation){try{reservation.row[17]='待重試';await put(reservation.range,[reservation.row]);}catch{}}
   if(error instanceof StorageError)throw error;fail('STORAGE_UNAVAILABLE','儲存連線未完成，請保留工作稿並重送；系統會沿用相同紀錄與檔案編號。');
  }finally{locked=false;}
 }
 return {save,initialize,firestoreRequest:(url,options)=>{
  if(!url.startsWith('https://firestore.googleapis.com/v1/projects/ntpc-ai-seag/databases/(default)/documents'))throw Error('Invalid Firestore destination');
  return api(url,options);
 }};
}
