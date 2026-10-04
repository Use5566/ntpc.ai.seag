import {API_BASE} from './api-config.js?v=0.6.0';
const $=id=>document.getElementById(id);
const labels={awaiting_vectorization:'待向量化',processing:'處理中',partial:'部分完成',failed:'待手動重試',ready:'已完成'};
let plan=null,nextPage='',busy=false;
const message=text=>{$('admin-message').textContent=text;};
function invalidate() {plan=null;$('plan').hidden=true;$('vector-confirm').checked=false;$('run-vector').disabled=true;}
function token(){const value=$('admin-token').value.trim();if(value.length<32||value.length>256||value.startsWith('AIza'))throw Error('請輸入獨立管理碼，不是 Gemini API Key。');return value;}
async function request(action,body){
 const r=await fetch(API_BASE+'/api/vector/'+action,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token()},body:JSON.stringify(body),credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(180000)});
 const data=await r.json();if(!r.ok)throw Error(data.error||'操作未完成，請重新查詢。');if(!data.result)throw Error('回覆格式不正確。');return data.result;
}
async function perform(work){if(busy)return;busy=true;document.body.inert=true;try{await work();}catch(e){message(e.name==='TimeoutError'?'連線逾時，請重新預覽確認已保存的進度。':e.message);invalidate();}finally{busy=false;document.body.inert=false;}}
function showPlan(p){
 plan=p;$('plan').hidden=false;$('plan-title').textContent=p.title;
 $('plan-details').textContent=`${labels[p.status]||p.status}｜共 ${p.totalChunks} 段，已完成 ${p.completedChunks} 段，尚餘 ${p.remainingChunks} 段。本次最多 ${Math.min(p.maxChunksPerClick,p.remainingChunks)} 段。`;
 $('plan-usage').textContent=`本批輸入約 ${p.nextInputCharacters} 字元（不是 token 或金額估算）。累計模型請求嘗試：${p.embeddingRequests} 次。`;
 $('vector-confirm').checked=false;$('vector-confirm').disabled=p.remainingChunks===0;$('run-vector').disabled=true;
}
async function load(pageToken=''){
 invalidate();message('正在查詢…');const r=await request('list',{pageToken});const root=$('jobs');root.replaceChildren();
 for(const item of r.items){const row=document.createElement('div');row.className='item-card';const text=document.createElement('p');text.textContent=`${item.title}｜${labels[item.status]||item.status}｜已完成 ${item.completedChunks}${item.totalChunks===null?'':(' / '+item.totalChunks)} 段`;
  const button=document.createElement('button');button.className='secondary';button.textContent='預覽處理範圍';button.addEventListener('click',()=>perform(async()=>{invalidate();showPlan(await request('preview',{documentId:item.documentId}));message('預覽完成，尚未呼叫向量模型。');}));row.append(text,button);root.append(row);
 }
 nextPage=r.nextPageToken;$('next-page').hidden=!nextPage;message(r.items.length?'查詢完成。':'目前沒有正式稿處理紀錄；請先在整理工具確認儲存正式稿。');
}
$('load-jobs').addEventListener('click',()=>perform(()=>load()));
$('next-page').addEventListener('click',()=>perform(()=>load(nextPage)));
$('admin-token').addEventListener('input',invalidate);
$('clear-token').addEventListener('click',()=>{$('admin-token').value='';$('jobs').replaceChildren();$('next-page').hidden=true;invalidate();message('管理碼已清除。');});
$('vector-confirm').addEventListener('change',()=>{$('run-vector').disabled=!plan||!plan.remainingChunks||!$('vector-confirm').checked;});
$('run-vector').addEventListener('click',()=>perform(async()=>{
 if(!plan||!$('vector-confirm').checked)throw Error('請先預覽並確認。');const selected=plan;
 $('run-vector').disabled=true;message('正在處理本批，請保持分頁開啟…');
 const result=await request('run',{documentId:selected.documentId,planHash:selected.planHash,confirmed:true});showPlan(result);
 message(`本批完成 ${result.processedNow} 段。${result.remainingChunks?'已停止，剩餘段落需再次勾選並手動開始。':'此稿件向量化完成。'}`);
}));
window.addEventListener('pagehide',()=>{$('admin-token').value='';invalidate();});
