// Shared schema helpers. No credentials or model instructions belong here.
export const META_VERSION='seag_metadata_v2';
export const metadataDefaults={domains:[],gradeBands:[],usageLicense:'',visibility:'token_holders'};
export function partialDate(value){
 if(value==='')return true;
 if(!/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value)||Number(value.slice(0,4))<1900)return false;
 const full=value.length===4?value+'-01-01':value.length===7?value+'-01':value;
 return !Number.isNaN(Date.parse(full))&&new Date(full).toISOString().slice(0,10)===full;
}
export function bodySections(body){
 const blocks=body.split(/\n\s*\n/).filter(s=>s.trim());let cursor=0;
 return blocks.map((text,i)=>{const pos=body.indexOf(text,cursor);cursor=pos+text.length;return {sectionId:'S'+String(i+1).padStart(3,'0'),text,start:[...body.slice(0,pos)].length,end:[...body.slice(0,cursor)].length};});
}
export function remapSections(previousBody,body,mapping=[]){
 const before=bodySections(previousBody),used=new Set();
 return bodySections(body).map(s=>{const old=before.find(x=>x.text===s.text&&!used.has(x.sectionId));if(old)used.add(old.sectionId);const m=old&&mapping.find(x=>x.sectionId===old.sectionId);return {sectionId:s.sectionId,sourceIds:m?[...m.sourceIds]:[],kind:m?.kind||'source'};});
}
export function validateSourceMap(body,map,sources,allowUnmapped=false){
 const sections=bodySections(body),ids=new Set(sources.map(s=>s.id));
 if(!Array.isArray(map)||map.length!==sections.length||map.length>3000)throw Error('每個整理稿段落都必須建立來源對照。');
 for(let i=0;i<map.length;i++){
  const m=map[i];
  if(!m||Object.keys(m).sort().join(',')!=='kind,sectionId,sourceIds'||m.sectionId!==sections[i].sectionId||!['source','supplement'].includes(m.kind)||!Array.isArray(m.sourceIds)||new Set(m.sourceIds).size!==m.sourceIds.length||m.sourceIds.some(id=>!ids.has(id))||(m.kind==='source'&&!m.sourceIds.length&&!allowUnmapped)||(m.kind==='supplement'&&m.sourceIds.length))throw Error('來源對照不正確；來源段落須指定有效 P 編號，事後補充不可冒充原稿。');
 }
 return map;
}
export function archiveExtras(d){return d.format==='seag_text_v2'?{sources:d.sources,sourceMap:d.sourceMap,lineage:d.lineage,sourceConfirmed:true}:{};}
export function layeredText(d){
 if(d.format!=='seag_text_v2')return '';
 return '\n\n文件與版本\n固定文件 ID：'+d.lineage.documentId+'\n版本：'+d.lineage.version+'\n取代版本紀錄：'+(d.lineage.previousRecordId||'無')+'\n修訂說明：'+d.lineage.changeNote+'\n領域：'+d.metadata.domains.join('、')+'\n適用年段：'+d.metadata.gradeBands.join('、')+'\n使用授權：內部知識庫整理與問答\n可見範圍：工具存取碼使用者；備份依 Drive 共用權限\n\n整理稿來源對照\n'+d.sourceMap.map(m=>m.sectionId+' → '+(m.kind==='supplement'?'提供者事後補充':m.sourceIds.join(', '))).join('\n')+'\n\n去識別詳細底稿（不自動向量化）\n'+d.sources.map(s=>'['+s.id+']\n'+s.text).join('\n\n')+'\n';
}
