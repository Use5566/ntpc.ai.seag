export const MAX_CHARS = 100000;
export function normalize(text) { return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'); }
export function termsFrom(text) { return [...new Set(normalize(text).split('\n').map(s => s.trim()).filter(Boolean))].sort((a,b) => b.length-a.length); }
export function redact(text, terms = []) {
  let value = normalize(text);
  for (const term of [...terms].sort((a,b)=>b.length-a.length)) if (term) value = value.split(term).join('[已遮蔽]');
  // Only anchored, explicit transcript labels; never claim general entity detection.
  value = value.replace(/^(?:參與者|參加者|主辦單位|承辦單位|hostOrganization|participantRoles)[：: \t]*.*$/gim, '[已移除識別欄位]');
  value = value.replace(/^(?:(?:講師|主持人|教師|老師|學員|學生|校長|組長|主任)|(?:[\d一二三四五六七八九十、.， \t]+年級(?:教師|老師)))(?:[、，,／/ \t]+(?:(?:講師|主持人|教師|老師|學員|學生|校長|組長|主任)|(?:[\d一二三四五六七八九十、.， \t]+年級(?:教師|老師))))*[ \t]*(?=\d{1,2}:\d{2}:\d{2}|$)/gm, '');
  return value.trim();
}
export function segmentsFrom(text) {
  return normalize(text).trim().split(/\n\s*\n/).filter(x=>x.trim()).map((text,i)=>({id:`P${String(i+1).padStart(3,'0')}`, text:text.trim()}));
}
export function secretLike(text) {
  return /\b(?:AIza[\w-]{30,}|sk-[\w-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text);
}
export function privacyIssues(text, terms=[]) {
  const issues=[];
  if(secretLike(text)) issues.push('內容疑似包含服務金鑰或私密金鑰，請先移除。');
  if(terms.some(t=>t && text.includes(t))) issues.push('內容仍含有你指定的遮蔽詞彙，請重新檢查。');
  if(/(?:hostOrganization|participantRoles|主辦單位|參與者角色)\s*["：:=]/i.test(text)) issues.push('內容含有禁止的身分欄位，請移除。');
  return issues;
}
function fail(message) { throw new Error(message); }
function shape(obj, keys, where) {
  if(!obj || typeof obj!=='object'||Array.isArray(obj)) fail(`${where} 必須是物件。`);
  const extra=Object.keys(obj).filter(k=>!keys.includes(k));
  if(extra.length) fail(`${where} 含有未允許欄位。請依 TXT 格式重新整理。`);
  for(const key of keys) if(!(key in obj)) fail(`${where} 缺少 ${key}。`);
}
function string(value, where, nonempty=false) { if(typeof value!=='string'||value.length>MAX_CHARS||(nonempty&&!value.trim())) fail(`${where} 必須是有效文字${nonempty?'，且不可空白':''}。`); }
function array(value, where, max=3000) { if(!Array.isArray(value)||value.length>max) fail(`${where} 必須是有效陣列。`); }
export function validDate(value) { return value==='' || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value); }
export function parseResult(input, segments, terms=[]) {
  if(typeof input!=='string'||input.length>1500000) fail('AI 結果過大或格式不正確。');
  let parsed;
  try { parsed=JSON.parse(input.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')); } catch { fail('無法讀取 JSON。請貼上完整結果，並檢查引號與逗號。'); }
  shape(parsed,['title','body','metadata','omissions','questions','coverage'],'整理結果');
  string(parsed.title,'title',true); string(parsed.body,'body',true);
  if(parsed.title.length>180) fail('標題請限制在 180 字元內。');
  shape(parsed.metadata,['eventDate','contentType','topics','summary','limitations'],'metadata');
  const m=parsed.metadata;
  string(m.eventDate,'日期'); if(!validDate(m.eventDate)) fail('日期必須為有效 YYYY-MM-DD 或空字串。');
  string(m.contentType,'資料類型',true);string(m.summary,'摘要');
  for(const key of ['topics','limitations']) { array(m[key],key,100); m[key].forEach(x=>string(x,key,true)); }
  const sourceIds=new Set(segments.map(s=>s.id));
  const allItemIds=new Set();
  for(const key of ['omissions','questions']) {
    array(parsed[key],key);
    for(const item of parsed[key]) {
      shape(item,key==='omissions'?['id','sourceIds','text','reason']:['id','sourceIds','question','context'],key);
      string(item.id,'項目 ID',true);
      if(!new RegExp(key==='omissions'?'^O[0-9]+$':'^Q[0-9]+$').test(item.id)||allItemIds.has(item.id)) fail('捨棄／問題 ID 必須正確且唯一。');
      allItemIds.add(item.id); array(item.sourceIds,'來源 ID');
      if(!item.sourceIds.length||new Set(item.sourceIds).size!==item.sourceIds.length||item.sourceIds.some(id=>!sourceIds.has(id))) fail('捨棄或問題使用了不存在或重複的來源 ID。');
      for(const k of key==='omissions'?['text','reason']:['question','context']) string(item[k],k,true);
    }
  }
  array(parsed.coverage,'coverage');
  const seen=new Set();
  for(const c of parsed.coverage) {
    shape(c,['sourceId','status','target'],'coverage 項目');
    if(!sourceIds.has(c.sourceId)||seen.has(c.sourceId)) fail('來源去向包含不存在或重複的段落 ID。');
    seen.add(c.sourceId);
    if(!['retained','merged','omitted','pending'].includes(c.status)) fail('來源去向的 status 不正確。');
    string(c.target,'去向',true);
    if(c.status==='omitted' && !parsed.omissions.some(o=>o.sourceIds.includes(c.sourceId)&&o.id===c.target)) fail('捨棄段落沒有對應的捨棄項目。');
    if(c.status==='pending' && !parsed.questions.some(q=>q.sourceIds.includes(c.sourceId)&&q.id===c.target)) fail('待確認段落沒有對應問題。');
  }
  if(seen.size!==sourceIds.size) fail(`來源去向不完整：目前 ${seen.size} / ${sourceIds.size} 段，請 AI 補齊後再匯入。`);
  const issues=privacyIssues(JSON.stringify(parsed),terms); if(issues.length) fail(issues.join('\n'));
  return parsed;
}
export const STATUS_LABELS={retained:'保留',merged:'合併轉譯',omitted:'完全捨棄',pending:'待確認'};
export function applyAnswers(result, answers) {
  const clone=structuredClone(result);
  const sections=[];
  for(const q of clone.questions) {
    const a=answers[q.id];
    if(!a||!['supplement','correct','unknown','exclude'].includes(a.action)) fail('每個問題都需要選擇處理方式。');
    if(['supplement','correct'].includes(a.action)&&!a.text?.trim()) fail('補充或更正需要填寫說明。');
    const labels={supplement:'事後補充',correct:'人工更正（以此說明為準）',unknown:'無法確認，保留不確定性',exclude:'決定不納入未確認內容'};
    sections.push(`${labels[a.action]} [${q.sourceIds.join(', ')}]\n原問題：${q.question}\n${a.text?.trim()||labels[a.action]}`);
    if(a.action==='unknown') clone.metadata.limitations.push(`待釐清：${q.question}`);
    // Resolve the processing state, without claiming an AI rewrite or verified fact.
    for(const c of clone.coverage) if(c.status==='pending'&&c.target===q.id) { c.status='retained';c.target='人工確認與補充（含不確定或不納入決定）'; }
  }
  if(sections.length) clone.body+='\n\n人工確認與補充\n以下是提供者於整理階段新增的說明，不是逐字稿原話。若與前文有衝突，請依更正修改前文後再定稿。\n\n'+sections.join('\n\n');
  clone.questions=[];
  return clone;
}
export function exportText(result, sourceCount, date=new Date().toISOString()) {
  return `知識整理稿\n格式版本：seag_text_v1\n整理版本：${date}\n來源段落數：${sourceCount}\n\n標題：${result.title}\n資料類型：${result.metadata.contentType}\n活動日期：${result.metadata.eventDate||'未確認'}\n主題：${result.metadata.topics.join('、')||'未指定'}\n\n整體摘要\n${result.metadata.summary}\n\n主題整理正文\n${result.body}\n\n內容限制\n${result.metadata.limitations.length?result.metadata.limitations.map(x=>'• '+x).join('\n'):'未另列；不代表內容已經外部查證。'}\n\n版本說明\n本稿由來源內容轉譯並經提供者檢閱，不是逐字引述；未進行外部專業查證。\n`;
}
