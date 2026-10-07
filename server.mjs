import {organizeSchema,parseOrganizeOutput} from './organize-output.mjs';
import {createChat,ChatError,validateChat} from './chat.mjs';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {MAX_CHARS,parseResult,secretLike,applyAnswers} from './core.js';
import {createStorage,StorageError,VERSION} from './storage.mjs';
import {createVectorizer,VectorError} from './vectorize.mjs';

class HttpError extends Error { constructor(status,message,code='REQUEST_FAILED'){super(message);this.status=status;this.code=code;} }
const fail=(status,message,code)=>{throw new HttpError(status,message,code);};
const digest=value=>createHash('sha256').update(value).digest();
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
export function validateInput(data){
  if(!plain(data)||Object.keys(data).some(k=>!['mode','title','source','currentDraft','editorDecisions','previousDecisions','metadataHints'].includes(k)))fail(400,'請求格式不正確。');
  if(!['analyze','revise'].includes(data.mode)||typeof data.title!=='string'||!data.title.trim()||data.title.length>180)fail(400,'請檢查標題及操作。');
  if(!Array.isArray(data.source)||!data.source.length||data.source.length>3000)fail(400,'來源段落數不正確。');
  if(data.source.some((s,i)=>!plain(s)||Object.keys(s).some(k=>!['id','text'].includes(k))||s.id!==`P${String(i+1).padStart(3,'0')}`||typeof s.text!=='string'||!s.text.trim()))fail(400,'來源段落格式不正確。');
  if(data.source.map(s=>s.text).join('\n\n').length>MAX_CHARS)fail(413,'逐字稿超過長度上限。');
  if(secretLike(JSON.stringify(data)))fail(400,'內容疑似包含金鑰或禁止的識別欄位，請先移除。');
  if(data.metadataHints!==undefined){if(!plain(data.metadataHints)||Object.keys(data.metadataHints).some(k=>!['eventDate','contentType','topics','context','domains','gradeBands'].includes(k))||Object.values(data.metadataHints).some(v=>typeof v!=='string'||v.length>2000))fail(400,'補充資料格式不正確。');}
  if(data.mode==='analyze'&&['currentDraft','editorDecisions','previousDecisions'].some(k=>k in data))fail(400,'初次整理不可夾帶修訂資料。');
  if(data.mode==='revise'){
    try{parseResult(JSON.stringify(data.currentDraft),data.source);if(!plain(data.editorDecisions)||!Array.isArray(data.previousDecisions))throw Error();applyAnswers(data.currentDraft,data.editorDecisions);}catch{fail(400,'請先完成每個問題的處理方式與必要說明，再交由 AI 修訂。');}
  }
  return data;
}
async function jsonBody(req){
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))fail(415,'請使用 JSON。');
  if(Number(req.headers['content-length'])>2000000)fail(413,'請求過大。');
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>2000000)fail(413,'請求過大。');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'JSON 格式不正確。');}
}
export async function createApp({env=process.env,fetchImpl=fetch,now=Date.now,storageImpl,vectorImpl,chatImpl}={}){
  const key=env.GEMINI_API_KEY||'',token=env.SEAG_ACCESS_TOKEN||'';
  if(!key||token.length<32||token.length>256||token===key)throw Error('請在 Render 設定 GEMINI_API_KEY 及不同的 SEAG_ACCESS_TOKEN（32–256 字元）。');
  const origin=env.ALLOWED_ORIGIN||'https://use5566.github.io';
  if(new URL(origin).origin!==origin||!origin.startsWith('https://'))throw Error('ALLOWED_ORIGIN 必須是完整 HTTPS origin，不含路徑。');
  const prompts=Object.fromEntries(await Promise.all(['system','analyze','revise','output-schema','repair'].map(async n=>[n,await readFile(new URL(`./prompt-${n}.txt`,import.meta.url),'utf8')])));
  const tokenHash=digest(token);let busy=false;let calls=[];
  const storage=storageImpl||createStorage({env,fetchImpl});
  const vector=vectorImpl||createVectorizer({api:storage.firestoreRequest,env,fetchImpl,now});
  const chat=chatImpl||createChat({api:storage.firestoreRequest,env,fetchImpl});
  const admin=env.SEAG_ADMIN_TOKEN||'';
  const adminReady=admin.length>=32&&admin.length<=256&&admin!==key&&admin!==token;
  const adminHash=digest(admin);let adminReads=[];
  const safeLimits=(name,fallback,max)=>{const n=Number(env[name]||fallback);if(!Number.isInteger(n)||n<1||n>max)throw Error(`${name} 設定不正確。`);return n;};
  const hourly=safeLimits('MAX_REQUESTS_PER_HOUR',20,100),daily=safeLimits('MAX_REQUESTS_PER_DAY',100,500);
  return http.createServer({requestTimeout:30000,headersTimeout:10000,maxHeaderSize:8192},async(req,res)=>{
    const send=(status,obj)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(obj));}};
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Vary','Origin');
    try{
      if(req.url==='/health'&&req.method==='GET'){send(200,{ok:true,version:VERSION});return;}
      const vectorRoute=['/api/vector/list','/api/vector/preview','/api/vector/run'].includes(req.url);
      if(!vectorRoute&&!['/api/organize','/api/archive','/api/chat','/api/document'].includes(req.url))fail(404,'找不到此端點。');
      if(req.headers.origin!==origin)fail(403,'不允許此網站來源。');
      res.setHeader('Access-Control-Allow-Origin',origin);
      if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','POST');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.writeHead(204);res.end();return;}
      if(req.method!=='POST')fail(405,'不支援此方法。');
      const auth=req.headers.authorization||'';
      if(vectorRoute&&!adminReady)fail(503,'管理者功能尚未設定，請檢查 SEAG_ADMIN_TOKEN。','ADMIN_CONFIG');
      if(!auth.startsWith('Bearer ')||!timingSafeEqual(digest(auth.slice(7)),vectorRoute?adminHash:tokenHash))fail(401,vectorRoute?'管理碼不正確，請重新輸入。':'存取碼不正確，請重新輸入。');
      const body=await jsonBody(req);
      const input=vectorRoute||['/api/archive','/api/document'].includes(req.url)?body:req.url==='/api/chat'?validateChat(body):validateInput(body);
      // Also reject accidental use of the exact server credentials in any input.
      const serialized=JSON.stringify(input);
      if(serialized.includes(key)||serialized.includes(token)||(admin&&serialized.includes(admin)))fail(400,'請移除內容中的憑證。');
      if(req.url==='/api/archive'&&(!body.sources||body.sourceConfirmed!==true))fail(400,'新版儲存必須附上已確認的去識別底稿與來源對照。');
      const time=now();calls=calls.filter(t=>time-t<86400000);
      if(vectorRoute){
        const action=req.url.split('/').at(-1),keys=action==='list'?['pageToken']:action==='preview'?['documentId']:['documentId','planHash','confirmed'];
        if(!plain(body)||Object.keys(body).some(k=>!keys.includes(k))||(action!=='list'&&keys.some(k=>!Object.hasOwn(body,k))))fail(400,'管理請求格式不正確。');
        if(action!=='run'){
          adminReads=adminReads.filter(t=>time-t<3600000);if(adminReads.length>=120)fail(429,'管理查詢次數已達上限，請稍後再試。');adminReads.push(time);
          send(200,{result:await vector[action](body)});return;
        }
      }
      if(busy)fail(429,'目前已有整理工作，請稍後再試。');
      if(calls.length>=daily||calls.filter(t=>time-t<3600000).length>=hourly)fail(429,'已達本服務的使用上限，請稍後再試。');
      busy=true;calls.push(time);
      if(req.url==='/api/document'){try{if(!plain(body)||Object.keys(body).join(',')!=='recordId')fail(400,'版本查詢格式不正確。');send(200,{document:await storage.readDocument(body.recordId)});}finally{busy=false;}return;}
      if(req.url==='/api/chat'){try{send(200,{result:await chat.ask(input)});}finally{busy=false;}return;}
      if(vectorRoute){try{send(200,{result:await vector.run(body)});}finally{busy=false;}return;}
      if(req.url==='/api/archive'){
        try{send(200,{archive:await storage.save(input)});}finally{busy=false;}
        return;
      }
      const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),240000);
      const disconnect=()=>{if(!res.writableEnded)controller.abort();};res.on('close',disconnect);
      try{
        const contents=[{role:'user',parts:[{text:serialized}]}];
        for(let attempt=0;attempt<2;attempt++){
        const response=await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',{
          method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},signal:controller.signal,
          body:JSON.stringify({systemInstruction:{parts:[{text:[prompts.system,prompts[input.mode],prompts['output-schema']].join('\n\n')}]},contents,generationConfig:{responseMimeType:'application/json',responseSchema:organizeSchema(),maxOutputTokens:65536}})
        });
        // Never return or log raw upstream errors, request headers, prompts, or transcripts.
        if(!response.ok){await response.body?.cancel();const code=({400:'UPSTREAM_REQUEST',401:'UPSTREAM_AUTH',403:'UPSTREAM_AUTH',404:'MODEL_UNAVAILABLE',429:'UPSTREAM_QUOTA'})[response.status]||'UPSTREAM_SERVICE';fail(response.status===429?429:502,'Gemini 呼叫失敗。',code);}
        const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>6000000)fail(502,'AI 回應過大，請縮短逐字稿。');chunks.push(chunk);}const raw=Buffer.concat(chunks).toString('utf8');
        let payload;try{payload=JSON.parse(raw);}catch{fail(502,'AI 回應格式不正確。');}
        const candidate=payload.candidates?.[0];
        if(candidate?.finishReason!=='STOP'){
          const reason=['MAX_TOKENS','SAFETY','RECITATION','OTHER','BLOCKLIST','PROHIBITED_CONTENT','SPII','MALFORMED_FUNCTION_CALL','UNEXPECTED_TOOL_CALL'].includes(candidate?.finishReason)?candidate.finishReason:'UNKNOWN';
          const number=x=>Number.isSafeInteger(x)&&x>=0?x:0;
          console.warn('SEAG_ORGANIZE_INCOMPLETE',JSON.stringify({reason,attempt:attempt+1,promptTokens:number(payload.usageMetadata?.promptTokenCount),outputTokens:number(payload.usageMetadata?.candidatesTokenCount),thoughtTokens:number(payload.usageMetadata?.thoughtsTokenCount)}));
          fail(502,'AI 未完整產生結果，原稿仍保留。',reason==='MAX_TOKENS'?'RESULT_OUTPUT_LIMIT':'RESULT_INCOMPLETE');
        }
        const output=(candidate.content?.parts||[]).filter(p=>!p.thought).map(p=>p.text||'').join('');
        if(output.includes(key)||output.includes(token)||(admin&&output.includes(admin)))fail(502,'AI 回應未通過安全檢查。');
        let result;
        try{result=parseOrganizeOutput(output,input.source);}
        catch(error){
          const time=now();calls=calls.filter(t=>time-t<86400000);
          if(attempt===0&&calls.length<daily&&calls.filter(t=>time-t<3600000).length<hourly){
            calls.push(time);
            contents.push({role:'model',parts:[{text:output}]},{role:'user',parts:[{text:prompts.repair+'\n'+(error instanceof SyntaxError?'JSON 語法不正確。':error.message)}]});
            continue;
          }
          fail(502,'AI 結果在一次格式修復後仍未通過來源或去識別檢查。原稿仍保留。','RESULT_INVALID');
        }
        send(200,{result});break;
        }

      }finally{clearTimeout(timer);res.off('close',disconnect);busy=false;}
    }catch(error){const known=error instanceof HttpError||error instanceof StorageError||error instanceof VectorError||error instanceof ChatError;send(known?error.status:503,{error:known?error.message:'服務暫時無法完成或已逾時，原稿仍保留，請稍後重試。',code:known?error.code:'SERVICE_TIMEOUT'});}
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const server=await createApp();server.listen(Number(process.env.PORT||10000),'0.0.0.0',()=>console.log('SEAG API 已啟動。'));}
  catch{console.error('SEAG API 無法啟動：請檢查環境變數與 TXT 檔案。');process.exitCode=1;}
}
