import {API_BASE} from './api-config.js';
const $=id=>document.getElementById(id);
function view(){const name=['import','vector','chat'].includes(location.hash.slice(1))?location.hash.slice(1):'import';for(const v of ['import','vector','chat'])$(v+'-workspace').hidden=v!==name;for(const a of document.querySelectorAll('.portal-nav a')){if(a.hash==='#'+name)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}}
window.addEventListener('hashchange',view);view();
let history=[],busy=false;
function message(label,text,sources=[]){const article=document.createElement('article');article.className='chat-entry';const h=document.createElement('h2');h.textContent=label;const p=document.createElement('p');p.className='chat-text';p.textContent=text;article.append(h,p);for(const source of sources){const d=document.createElement('details'),s=document.createElement('summary'),p=document.createElement('p');s.textContent=`[${source.id}] ${source.title}`;p.className='chat-text';p.textContent=source.text+(source.version?'\n版本：'+source.version+' ／ 底稿來源：'+(source.sourceIds?.join(', ')||'事後補充'):'');d.append(s,p);article.append(d);}$('chat-messages').append(article);}
$('chat-send').addEventListener('click',async()=>{
 if(busy)return;const token=$('chat-token').value.trim(),question=$('chat-question').value.trim();
 if(token.length<32||token.length>256||token.startsWith('AIza')){$('chat-status').textContent='請輸入工具存取碼（SEAG_ACCESS_TOKEN），不是 Gemini API Key。';return;}
 if(!question){$('chat-status').textContent='請輸入問題。';return;}
 busy=true;$('chat-send').disabled=true;$('chat-clear').disabled=true;$('chat-status').textContent='正在查詢知識庫…';
 try{let recent=history.slice(-6);while(JSON.stringify(recent).length>18000)recent=recent.slice(2);
 const r=await fetch(API_BASE+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({question,history:recent}),credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(180000)});const data=await r.json();if(!r.ok)throw Error(data.error||'查詢失敗。');
 message('你',question);message('知識庫回答',data.result.answer,data.result.sources);history.push({role:'user',text:question},{role:'assistant',text:data.result.answer});history=history.slice(-6);$('chat-question').value='';$('chat-status').textContent='回答完成，請核對來源段落。';
 }catch(e){$('chat-status').textContent=e.name==='TimeoutError'?'查詢逾時，請稍後重試。':e.message;}finally{busy=false;$('chat-send').disabled=false;$('chat-clear').disabled=false;}
});
$('chat-clear').addEventListener('click',()=>{history=[];$('chat-messages').replaceChildren();$('chat-token').value='';$('chat-question').value='';$('chat-status').textContent='已清除。';});
window.addEventListener('pagehide',()=>{history=[];$('chat-token').value='';$('chat-messages').replaceChildren();});
