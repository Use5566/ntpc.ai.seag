import {MAX_CHARS,normalize,termsFrom,redact,segmentsFrom,privacyIssues,secretLike,parseResult,applyAnswers,exportText,STATUS_LABELS,validDate,resolvePrivacy} from './core.js?v=0.4.0';
import {API_BASE} from './api-config.js?v=0.4.0';

const $=id=>document.getElementById(id);
const state={step:0,maxStep:0,segments:[],result:null,terms:[],answers:{},history:[],dirty:false,taskKey:'',prompts:null};
const privacyDecisions={};
const headings=[['匯入逐字稿','貼上逐字稿或匯入 UTF-8 文字檔。'],['去識別確認','檢查標題及正文，移除不應傳送的資訊。'],['AI 整理與去識別建議','同時分析整理內容、識別資訊與待確認問題。'],['檢閱與校訂','核對正文、metadata、捨棄清單與待確認問題。'],['確認與儲存','核對正式稿後，存為 TXT 並登記紀錄。']];
function message(text,ok=false){$('message').textContent=text;$('message').classList.toggle('success',ok);$('message').hidden=false;}
function clearMessage(){$('message').hidden=true;}
function dirty(){state.dirty=true;$('final-confirm').checked=false;$('export-txt').disabled=true;$('save-cloud').disabled=true;$('archive-receipt').hidden=true;}
function go(step){if(step>state.maxStep)return;clearMessage();state.step=step;document.querySelectorAll('.panel').forEach((el,i)=>el.hidden=i!==step);document.querySelectorAll('[data-step]').forEach((el)=>{const i=Number(el.dataset.step);el.disabled=i>state.maxStep;el.classList.toggle('active',i===step);el.classList.toggle('done',i<step);if(i===step)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');});$('page-title').textContent=headings[step][0];$('page-description').textContent=headings[step][1];$('step-label').textContent=`步驟 ${{0:1,2:2,3:3,4:4}[step]||2} / 4`;$('document-status').textContent=state.result?'人工檢閱中':step>0?'本機工作中':'尚未建立草稿';window.scrollTo({top:0,behavior:'instant'});$('workspace').focus({preventScroll:true});}
function bind(id,event,fn){$(id).addEventListener(event,async e=>{try{await fn(e);}catch(error){message(error.message||'操作未完成，請再試一次。');}});}
function assertSafe(text){const issues=privacyIssues(text,state.terms);if(issues.length)throw new Error(issues.join('\n'));}
function sourceChanged(){$('ai-consent').checked=false;state.result=null;state.segments=[];state.answers={};state.history=[];state.taskKey='';state.maxStep=0;dirty();const n=$('source-text').value.length;$('source-count').textContent=`${n.toLocaleString()} 字元`;$('to-privacy').disabled=!$('source-text').value.trim()||n>MAX_CHARS;document.querySelectorAll('[data-step]').forEach(el=>el.disabled=Number(el.dataset.step)>0);}
function previewChanged(){state.result=null;state.answers={};state.history=[];state.maxStep=1;state.taskKey='';$('privacy-confirm').checked=false;$('to-ai').disabled=true;dirty();document.querySelectorAll('[data-step]').forEach(el=>el.disabled=Number(el.dataset.step)>1);}
async function confirmAction(text){$('confirm-message').textContent=text;const d=$('confirm-dialog');d.showModal();return new Promise(resolve=>{let answer=false;const yes=()=>{answer=true;d.close();};const no=()=>d.close();const close=()=>{$('confirm-yes').removeEventListener('click',yes);$('confirm-cancel').removeEventListener('click',no);resolve(answer);};$('confirm-yes').addEventListener('click',yes);$('confirm-cancel').addEventListener('click',no);d.addEventListener('close',close,{once:true});});}
function download(name,text,type='text/plain;charset=utf-8'){assertSafe(text);const blob=new Blob(['\uFEFF',text],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),15000);}
function safeName(title){return title.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,65)||'知識整理稿';}
async function readFile(file,max=1500000){if(!file)throw new Error('尚未選取檔案。');if(file.size>max*4)throw new Error('檔案超過大小上限。');let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());}catch{throw new Error('檔案不是 UTF-8 文字，請另存為 UTF-8 後重試。');}text=normalize(text);if(text.length>max)throw new Error('文字超過長度上限。');return text;}
async function prompts(){if(state.prompts)return state.prompts;const names=['system','analyze','revise','output-schema'];const values=await Promise.all(names.map(async name=>{const res=await fetch(`./prompt-${name}.txt`,{cache:'no-cache'});if(!res.ok)throw new Error('無法讀取 TXT 提示詞。請透過網站網址開啟，不要直接雙擊 HTML。');return res.text();}));state.prompts=Object.fromEntries(names.map((n,i)=>[n,values[i]]));return state.prompts;}
async function task(revise=false){const p=await prompts();const input={title:$('safe-title').value,source:state.segments,metadataHints:{eventDate:$('hint-date').value,contentType:$('hint-type').value,topics:$('hint-topics').value,context:$('hint-context').value}};if(revise){syncResult();input.currentDraft=state.result;input.editorDecisions=state.answers;input.previousDecisions=state.history;}const output=[p.system,p[revise?'revise':'analyze'],p['output-schema'],JSON.stringify(input,null,2)].join('\n\n================\n\n');if(!revise&&!$('ai-consent').checked)throw new Error('請先確認可將內容提供給 AI。');if(secretLike(JSON.stringify(input)))throw new Error('內容疑似包含金鑰。');return output;}
// Instructions come only from TXT files. These labels are UI/export labels, not model prompts.
function el(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
function setTab(tab){document.querySelectorAll('[data-tab]').forEach(b=>{const active=b.dataset.tab===tab;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;});for(const key of ['draft','privacy','metadata','omissions','questions','coverage'])$('view-'+key).hidden=key!==tab;}
function syncResult(){if(!state.result)return;const r=state.result;r.title=$('draft-title').value.trim();r.body=$('draft-body').value;r.metadata={eventDate:$('meta-date').value,contentType:$('meta-type').value.trim(),topics:termsFrom($('meta-topics').value),summary:$('meta-summary').value,limitations:termsFrom($('meta-limitations').value)};}
function validateEdited(){syncResult();if(state.result?.privacyCandidates?.length)throw new Error('請先完成去識別建議的決定。');if(!state.result?.title||!state.result.body.trim())throw new Error('請填寫標題及整理正文。');if(!state.result.metadata.contentType)throw new Error('請填寫資料類型。');if(!validDate(state.result.metadata.eventDate))throw new Error('請檢查活動日期。');if(state.result.body.length>MAX_CHARS)throw new Error('整理正文超過長度上限。');assertSafe(JSON.stringify(state.result));}
function renderResult(){const r=state.result;$('review-title').textContent=r.title;$('coverage-status').textContent=`${r.coverage.length} / ${state.segments.length} 段已列出處理去向 · 仍需核對細節`;$('draft-title').value=r.title;$('draft-body').value=r.body;$('meta-date').value=r.metadata.eventDate;$('meta-type').value=r.metadata.contentType;$('meta-topics').value=r.metadata.topics.join('\n');$('meta-summary').value=r.metadata.summary;$('meta-limitations').value=r.metadata.limitations.join('\n');$('omission-count').textContent=r.omissions.length;$('question-count').textContent=r.questions.length;renderPrivacy();renderOmissions();renderQuestions();renderCoverage();}
function renderOmissions(){const root=$('omissions-list');root.replaceChildren();if(!state.result.omissions.length)root.append(el('p','目前沒有列出的捨棄項目。','empty-state'));for(const o of state.result.omissions){const box=el('article',undefined,'item-card');box.append(el('span',`${o.id} · ${o.sourceIds.join(' / ')}`,'source-ref'),el('div',o.text,'quote'),el('p',`原因：${o.reason}`));const button=el('button','恢復至整理正文','secondary');button.addEventListener('click',()=>{syncResult();state.result.body+=`\n\n人工恢復的來源內容 [${o.sourceIds.join(', ')}]\n${o.text}`;state.result.omissions=state.result.omissions.filter(item=>item.id!==o.id);for(const c of state.result.coverage)if(c.status==='omitted'&&c.target===o.id){c.status='retained';c.target='人工恢復的來源內容';}state.history.push({type:'restore',id:o.id,sourceIds:o.sourceIds});dirty();renderResult();message('已恢復到正文末尾，請在主題整理稿中調整段落。',true);});box.append(button);root.append(box);}}
function renderQuestions(){const root=$('questions-list');root.replaceChildren();if(!state.result.questions.length)root.append(el('p','目前沒有尚待處理的問題。仍可在正文與內容限制中手動補充。','empty-state'));for(const q of state.result.questions){const box=el('article',undefined,'item-card');box.append(el('span',`${q.id} · ${q.sourceIds.join(' / ')}`,'source-ref'),el('h3',q.question),el('p',q.context));const label=el('label','處理方式','field-label');label.htmlFor='action-'+q.id;const select=el('select');select.id='action-'+q.id;for(const [v,t] of [['','請選擇'],['supplement','補充說明（事後新增）'],['correct','更正內容'],['unknown','無法確認，保留不確定性'],['exclude','決定不納入此未確認內容']]){const option=el('option',t);option.value=v;select.append(option);}const answerLabel=el('label','你的說明','field-label');answerLabel.htmlFor='answer-'+q.id;const area=el('textarea');area.id='answer-'+q.id;area.maxLength=10000;area.placeholder='補充或更正請填寫內容；無法確認時可以留空。';select.value=state.answers[q.id]?.action||'';area.value=state.answers[q.id]?.text||'';const update=()=>{state.answers[q.id]={action:select.value,text:area.value};dirty();};select.addEventListener('change',update);area.addEventListener('input',update);box.append(label,select,answerLabel,area);root.append(box);}$('apply-answers').disabled=!state.result.questions.length;}
function renderCoverage(){const root=$('coverage-list');root.replaceChildren();for(const c of state.result.coverage){const box=el('div',undefined,'item-card');box.append(el('span',c.sourceId,'source-ref'),el('h3',STATUS_LABELS[c.status]),el('p',c.target));const details=el('details');details.append(el('summary','對照來源'),el('div',state.segments.find(s=>s.id===c.sourceId)?.text||'','quote'));box.append(details);root.append(box);}}
function acceptResult(text){const result=parseResult(text,state.segments,state.terms);state.result=result;state.answers={};state.maxStep=3;dirty();renderResult();setTab(result.privacyCandidates.length?'privacy':'draft');go(3);message('格式與來源去向檢查通過。請逐項核對內容，這不代表 AI 已完整保留每個細節。',true);}
function draftPackage(){validateEdited();assertSafe(JSON.stringify(state.answers));assertSafe(JSON.stringify(state.history));return {format:'seag_work_v1',safeTitle:$('safe-title').value,segments:state.segments,result:state.result,answers:state.answers,history:state.history};}
async function resume(file){const text=await readFile(file);let data;try{data=JSON.parse(text);}catch{throw new Error('工作稿不是有效 JSON。');}if(data.format!=='seag_work_v1'||typeof data.safeTitle!=='string'||!Array.isArray(data.segments)||!data.segments.length)throw new Error('這不是可使用的 SEAG 工作稿。');if(data.segments.length>3000||data.segments.some((s,i)=>!s||s.id!==`P${String(i+1).padStart(3,'0')}`||typeof s.text!=='string'||Object.keys(s).some(k=>!['id','text'].includes(k))))throw new Error('工作稿的來源段落格式不正確。');const safe=data.segments.map(s=>s.text).join('\n\n');if(safe.length>MAX_CHARS||secretLike(text))throw new Error('工作稿過大或疑似包含金鑰。');const result=parseResult(JSON.stringify(data.result),data.segments,[]);const issues=privacyIssues(safe+'\n'+data.safeTitle,[]);if(issues.length)throw new Error(issues.join('\n'));if(state.dirty&&!await confirmAction('匯入會替換目前內容。確定已下載需要保留的工作稿？'))return;state.terms=[];state.segments=data.segments;state.result=result;state.answers={};state.history=[];$('redaction-terms').value='';$('source-text').value=safe;$('source-title').value=data.safeTitle;$('safe-source').value=safe;$('safe-title').value=data.safeTitle;$('privacy-confirm').checked=false;state.maxStep=3;state.taskKey='';renderResult();setTab('draft');go(3);dirty();$('help-dialog').close();message('已載入去識別來源與草稿。為避免沿用未核對的回答，待確認問題需要重新處理；匯出前請再次檢查遮蔽資訊。',true);}

document.querySelectorAll('[data-step]').forEach(b=>b.addEventListener('click',()=>{if(state.result)syncResult();if(Number(b.dataset.step)===4){$('final-preview').textContent=exportText(state.result,state.segments.length);$('final-confirm').checked=false;$('export-txt').disabled=true;}go(Number(b.dataset.step));}));
document.querySelectorAll('[data-back]').forEach(b=>b.addEventListener('click',()=>{syncResult();go(Number(b.dataset.back));}));
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>$(b.dataset.close).close()));
document.querySelectorAll('[data-tab]').forEach(b=>{b.addEventListener('click',()=>setTab(b.dataset.tab));b.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const tabs=[...document.querySelectorAll('[data-tab]')];let index=tabs.indexOf(b);index=e.key==='Home'?0:e.key==='End'?tabs.length-1:(index+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;setTab(tabs[index].dataset.tab);tabs[index].focus();});});
for(const id of ['source-text','source-title','hint-date','hint-type','hint-topics','hint-context'])bind(id,'input',sourceChanged);
for(const id of ['safe-title','safe-source'])bind(id,'input',previewChanged);
bind('redaction-terms','input',()=>{state.terms=termsFrom($('redaction-terms').value);previewChanged();});
for(const id of ['draft-title','draft-body','meta-date','meta-type','meta-topics','meta-summary','meta-limitations'])bind(id,'input',()=>{dirty();state.maxStep=3;document.querySelector('[data-step="4"]').disabled=true;});
bind('help-button','click',()=>$('help-dialog').showModal());
bind('source-file','change',async e=>{const f=e.target.files[0];if(!f)return;$('source-text').value=await readFile(f,MAX_CHARS);sourceChanged();e.target.value='';message('已在本機讀取文字，尚未上傳。請填寫中性工作標題。',true);});
bind('to-privacy','click',()=>{
 const source=normalize($('source-text').value).trim();
 if(!source||source.length>MAX_CHARS)throw new Error('請填入有效逐字稿。');
 if(secretLike(source)||secretLike($('source-title').value))throw new Error('內容疑似包含金鑰，請先移除。');
 if(!validDate($('hint-date').value))throw new Error('日期不正確。');
 state.terms=[];state.segments=segmentsFrom(source);
 if(state.segments.length>3000)throw new Error('段落數過多，請拆分內容。');
 $('safe-source').value=source;$('safe-title').value=$('source-title').value.trim()||'未命名知識稿';
 state.taskKey=source;state.maxStep=2;$('segment-count').textContent=state.segments.length;$('safe-count').textContent=source.length.toLocaleString();go(2);
});
bind('apply-redaction','click',()=>{state.terms=termsFrom($('redaction-terms').value);$('safe-source').value=redact($('safe-source').value,state.terms);$('safe-title').value=redact($('safe-title').value,state.terms);previewChanged();message('已更新預覽。自動規則不涵蓋所有識別資訊，請檢查正文及標題。',true);});
bind('privacy-confirm','change',()=>{$('to-ai').disabled=!$('privacy-confirm').checked;});
bind('to-ai','click',()=>{if(!$('privacy-confirm').checked)return;const safe=$('safe-source').value.trim();const title=$('safe-title').value.trim();if(!safe||!title||safe.length>MAX_CHARS)throw new Error('請填寫中性標題及有效的去識別逐字稿。');assertSafe(safe+'\n'+title);const key=title+'\n'+safe;if(state.taskKey!==key){state.result=null;state.answers={};state.history=[];state.maxStep=2;}$('safe-title').value=title;state.taskKey=key;state.segments=segmentsFrom(safe);if(state.segments.length>3000)throw new Error('來源段落超過 3,000 段，請拆成較小的工作單位。');$('ai-json').value='';$('segment-count').textContent=state.segments.length;$('safe-count').textContent=safe.length.toLocaleString();state.maxStep=Math.max(state.maxStep,2);go(2);});
bind('download-task','click',async()=>{const content=await task();download('AI整理任務.txt',content);message('已下載。任務含本次來源，請確認後再交給你選用的 AI 服務。',true);});
bind('copy-task','click',async()=>{const content=await task();try{await navigator.clipboard.writeText(content);message('已複製整理任務。',true);}catch{throw new Error('瀏覽器未允許複製，請改用下載 AI 整理任務。');}});
bind('import-result','click',()=>acceptResult($('ai-json').value));
bind('result-file','change',async e=>{const f=e.target.files[0];if(!f)return;$('ai-json').value=await readFile(f);e.target.value='';message('已讀取 JSON，請按「檢查並開啟草稿」。',true);});
bind('toggle-source','click',()=>{const root=$('source-blocks');root.replaceChildren();for(const s of state.segments){const block=el('article',undefined,'item-card');block.append(el('span',s.id,'source-ref'),el('div',s.text,'quote'));root.append(block);}$('source-dialog').showModal();});
bind('apply-answers','click',()=>{validateEdited();assertSafe(JSON.stringify(state.answers));const next=applyAnswers(state.result,state.answers);state.history.push({type:'answers',questions:structuredClone(state.result.questions),answers:structuredClone(state.answers)});state.result=next;state.answers={};dirty();renderResult();setTab('draft');message('已加入標示清楚的人工補充，尚未由 AI 重寫。若有更正或不納入決定，請同步修改前文與 metadata，或下載 AI 修訂任務。',true);});
bind('download-revision','click',async()=>{validateEdited();const content=await task(true);download('AI修訂任務.txt',content);message('已下載修訂任務，包含目前人工修改及處理決定。',true);});
bind('import-revision','click',async()=>{const text=$('revision-json').value;parseResult(text,state.segments,state.terms);if(!await confirmAction('修訂結果會替換目前的正文、metadata 與清單。確認已保存需要保留的人工修改？'))return;acceptResult(text);$('revision-json').value='';});
bind('save-work','click',()=>{download(safeName(state.result.title)+'_工作稿.json',JSON.stringify(draftPackage(),null,2),'application/json');message('已下載工作稿（包含去識別來源）。關閉前請確認下載成功。',true);});
bind('resume-file','change',async e=>{if(e.target.files[0])await resume(e.target.files[0]);e.target.value='';});
bind('resume-file-help','change',async e=>{if(e.target.files[0])await resume(e.target.files[0]);e.target.value='';});
bind('to-final','click',()=>{validateEdited();if(state.result.questions.length){setTab('questions');throw new Error('尚有待處理問題。請回答並納入人工補充，或匯入釐清後的 AI 修訂稿。');}$('final-preview').textContent=exportText(state.result,state.segments.length);$('final-confirm').checked=false;$('export-txt').disabled=true;$('save-cloud').disabled=true;$('archive-receipt').hidden=true;state.maxStep=4;go(4);});
bind('final-confirm','change',()=>{$('export-txt').disabled=!$('final-confirm').checked;$('save-cloud').disabled=!$('final-confirm').checked;});
bind('export-txt','click',()=>{if(!$('final-confirm').checked)return;validateEdited();if(state.result.questions.length)throw new Error('尚有未處理問題。');download(safeName(state.result.title)+'.txt',$('final-preview').textContent);message('TXT 備份已下載；下載不會上傳。請按「確認送出並儲存」完成雲端存檔。',true);});
bind('export-audit','click',()=>{const data=draftPackage();download(safeName(state.result.title)+'_編輯紀錄.json',JSON.stringify(data,null,2),'application/json');message('已另存去識別編輯紀錄。這份紀錄含來源與捨棄內容，請勿當作正式知識稿入庫。',true);});
bind('reset-button','click',async()=>{if(!await confirmAction('清除目前內容？未下載的草稿將無法復原。'))return;state.dirty=false;location.reload();});
window.addEventListener('beforeunload',e=>{if(state.dirty){e.preventDefault();e.returnValue='';}});
setTab('draft');

async function runAI(revise=false){
  const field=$(revise?'revision-token':'access-token');
  const token=field.value.trim();
  if(token.length<32||token.length>256||secretLike(token))throw new Error('請輸入工具存取碼，不是 Gemini API Key。');
  if(!revise&&!$('ai-consent').checked)throw new Error('請先確認同意將文字交由 AI 分析。');
  if(revise)validateEdited();
  const input={mode:revise?'revise':'analyze',title:$('safe-title').value,source:state.segments,metadataHints:{eventDate:$('hint-date').value,contentType:$('hint-type').value,topics:$('hint-topics').value,context:$('hint-context').value}};
  if(revise){applyAnswers(state.result,state.answers);input.currentDraft=state.result;input.editorDecisions=state.answers;input.previousDecisions=state.history;}
  if(secretLike(JSON.stringify(input)))throw new Error('內容疑似包含金鑰，請先移除。');
  field.value='';if(revise)$('token-dialog').close();
  message('AI 處理中，請勿關閉分頁。首次啟動服務可能較慢，最多等待約兩分鐘。',true);
  document.body.inert=true;
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),125000);
  try{
    const response=await fetch(`${API_BASE}/api/organize`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},body:JSON.stringify(input),signal:controller.signal,credentials:'omit',cache:'no-store',redirect:'error'});
    let data;try{data=await response.json();}catch{throw new Error('後端尚未就緒或回傳格式不正確，原稿仍保留。');}
    const diagnostics={MODEL_UNAVAILABLE:'目前金鑰無法使用 gemini-3.5-flash-lite（Google 回傳 404）。請確認帳號可用的模型。',UPSTREAM_AUTH:'Google 拒絕金鑰或專案權限（401／403）。請檢查 Render 的 GEMINI_API_KEY 與 Google API 設定。',UPSTREAM_REQUEST:'Google 不接受目前模型請求（400），請管理者檢查模型與參數相容性。',UPSTREAM_QUOTA:'Gemini 額度或速率已達上限。',UPSTREAM_SERVICE:'Google 服務暫時失敗，請稍後再試。',RESULT_INCOMPLETE:'Gemini 未完整產生結果，可能達輸出上限或被安全機制阻擋。請縮短內容後再試。',RESULT_INVALID:'Gemini 已回應，但 JSON 格式、來源對應或去識別候選未通過檢查。請重試或拆分逐字稿。'};
    if(!response.ok&&Object.hasOwn(diagnostics,data.code))throw new Error(diagnostics[data.code]);
    if(!response.ok)throw new Error(({401:'存取碼不正確，請重新輸入。',403:'網站來源未獲允許，請管理者檢查設定。',400:'請先完成問題回覆並檢查內容格式及去識別資訊。',413:'內容超過上限，請拆分逐字稿。',429:'服務忙碌或已達使用上限，請稍後再試。',502:'Gemini 呼叫或結果檢查失敗，請縮短內容重試；若持續失敗請管理者檢查金鑰及模型權限。',503:'服務啟動中或已逾時，請稍後再試。'})[response.status]||'AI 整理未完成，原稿仍保留。');
    acceptResult(JSON.stringify(data.result));
  }catch(error){if(error.name==='AbortError'||error instanceof TypeError)throw new Error('無法連線或等待逾時，原稿仍保留。請確認 Render 已部署完成後再試。');throw error;}
  finally{clearTimeout(timer);document.body.inert=false;}
}
bind('run-ai','click',()=>runAI());
bind('run-revision','click',()=>{validateEdited();applyAnswers(state.result,state.answers);$('revision-token').value='';$('token-dialog').showModal();});
bind('confirm-revision','click',()=>runAI(true));

function renderPrivacy(){
 const root=$('privacy-list');root.replaceChildren();
 for(const k of Object.keys(privacyDecisions))delete privacyDecisions[k];
 const candidates=state.result.privacyCandidates||[];
 $('privacy-count').textContent=candidates.length;$('apply-privacy').disabled=!candidates.length;
 if(!candidates.length)root.append(el('p','AI 沒有列出待確認項目，或項目已處理。仍請人工檢查是否有遺漏。'));
 for(const c of candidates){
  const box=el('article',undefined,'item-card');box.append(el('span',c.sourceIds.join(' / '),'source-ref'),el('h3',c.text),el('p',c.reason),el('p',`遮蔽後代稱：${c.replacement}`));
  const label=el('label','處理方式','field-label');label.htmlFor='privacy-'+c.id;const select=el('select');select.id=label.htmlFor;
  for(const [value,text] of [['','請選擇'],['redact','遮蔽這段文字'],['keep','保留（確認不需遮蔽）']]){const option=el('option',text);option.value=value;select.append(option);}
  select.addEventListener('change',()=>{privacyDecisions[c.id]=select.value;});box.append(label,select);root.append(box);
 }
}
bind('apply-privacy','click',()=>{
 syncResult();const resolved=resolvePrivacy(state.result,state.segments,privacyDecisions);
 state.result=resolved.result;state.segments=resolved.segments;
 $('safe-source').value=state.segments.map(s=>s.text).join('\n\n');$('safe-title').value=state.result.title;
 // Discard the raw import text after the provider's choices have been applied.
 $('source-text').value=$('safe-source').value;$('source-title').value=state.result.title;$('hint-date').value=state.result.metadata.eventDate;$('hint-type').value=state.result.metadata.contentType;$('hint-topics').value=state.result.metadata.topics.join('、');$('hint-context').value='';
 dirty();renderResult();setTab('draft');message('已將決定套用到來源、正文與 metadata。請繼續核對待確認問題及有無遺漏。',true);
});

window.addEventListener('pageshow',()=>{if(state.step===0){const n=$('source-text').value.length;$('source-count').textContent=`${n.toLocaleString()} 字元`;$('to-privacy').disabled=!$('source-text').value.trim()||n>MAX_CHARS;}});

bind('save-cloud','click',()=>{
 if(!$('final-confirm').checked)throw new Error('請先完成正式稿的人工確認。');
 validateEdited();if(state.result.questions.length)throw new Error('請先完成待確認問題。');
 $('archive-token').value='';$('archive-dialog').showModal();
});
bind('confirm-archive','click',async()=>{
 if(!$('final-confirm').checked)throw new Error('請先完成正式稿的人工確認。');
 validateEdited();if(state.result.questions.length)throw new Error('請先完成待確認問題。');
 const token=$('archive-token').value.trim();
 if(token.length<32||token.length>256||secretLike(token))throw new Error('請輸入工具存取碼，不是 Gemini API Key。');
 const input={title:state.result.title,body:state.result.body,metadata:structuredClone(state.result.metadata),sourceCount:state.segments.length,confirmed:true};
 $('archive-token').value='';$('archive-dialog').close();document.body.inert=true;
 message('正在儲存 TXT 與紀錄，請勿關閉分頁。',true);
 try{
  const r=await fetch(`${API_BASE}/api/archive`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(input),credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(180000)});
  const data=await r.json();if(!r.ok){const code=data.code||'';throw new Error(code.startsWith('STORAGE_')?data.error:r.status===401?'存取碼不正確，請重新輸入。':r.status===429?'服務忙碌或已達使用上限，請稍後再試。':'儲存未完成，請保留工作稿並稍後重送。');}
  const a=data.archive;
  if(!a||!/^https:\/\/drive\.google\.com\/file\/d\/[\w-]+\/view$/.test(a.fileUrl)||a.spreadsheetUrl!=='https://docs.google.com/spreadsheets/d/1lvZLaRW6ULLGXASGBhvIoOOEPsk3nq6iiK0sxUnl77o/edit#gid=0')throw new Error('儲存回覆未通過檢查，請重送確認。');
  const root=$('archive-receipt');root.replaceChildren(el('p',a.reused?'相同稿件已儲存，沿用既有紀錄。':'TXT 與試算表紀錄均已儲存。'),el('p',`檔名：${a.fileName}`),el('p',`完成時間：${a.savedAt}`));
  for(const [label,url]of [['開啟 TXT',a.fileUrl],['開啟紀錄表',a.spreadsheetUrl]]){const link=el('a',label);link.href=url;link.target='_blank';link.rel='noopener noreferrer';root.append(link,document.createTextNode('　'));}
  root.hidden=false;$('save-cloud').disabled=true;
  message('儲存完成。原始逐字稿與編輯歷程仍只在本次頁面；需要續編時請另存工作稿。',true);
 }catch(e){if(e.name==='TimeoutError'||e.name==='AbortError'||e instanceof TypeError)throw new Error('連線未完成，請保留工作稿並重送。系統會核對相同內容，避免重複建檔。');throw e;}
 finally{document.body.inert=false;}
});
$('archive-dialog').addEventListener('close',()=>{$('archive-token').value='';});
