import {bodySections} from './knowledge.js?v=0.9.0';
// Remove only bracketed references to known source IDs, never ordinary prose.
export function cleanReferences(text,sources){const ids=new Set(sources.map(s=>s.id));return text.replace(/[ \t]*\[((?:P\d+\s*[,，、]\s*)*P\d+)\]/g,(all,inside)=>inside.split(/\s*[,，、]\s*/).every(x=>ids.has(x))?'':all);}
export function reviewRows(result,sources){return bodySections(result.body).map(s=>{const m=result.sourceMap?.find(m=>m.sectionId===s.sectionId);const text=cleanReferences(s.text,sources);return {before:text,text,sourceIds:[...(m?.sourceIds||[])],kind:m?.kind||'source'};});}
export function commitRows(rows){const sections=[];for(const r of rows)for(const s of bodySections(r.text))sections.push({text:s.text,sourceIds:r.kind==='supplement'?[]:[...r.sourceIds],kind:r.kind});return {body:sections.map(s=>s.text).join('\n\n'),sourceMap:sections.map((s,i)=>({sectionId:'S'+String(i+1).padStart(3,'0'),sourceIds:s.sourceIds,kind:s.kind}))};}
export function changes(before,after){
 const a=Array.from(before),b=Array.from(after);let start=0,end=0;
 while(start<a.length&&start<b.length&&a[start]===b[start])start++;
 while(end<a.length-start&&end<b.length-start&&a[a.length-1-end]===b[b.length-1-end])end++;
 const x=a.slice(start,a.length-end),y=b.slice(start,b.length-end),out=[];
 const add=(kind,text)=>{if(!text)return;if(out.at(-1)?.kind===kind)out.at(-1).text+=text;else out.push({kind,text});};
 add('same',a.slice(0,start).join(''));
 if(x.length*y.length>1000000){add('delete',x.join(''));add('insert',y.join(''));}
 else{const dp=Array.from({length:x.length+1},()=>new Uint32Array(y.length+1));for(let i=x.length-1;i>=0;i--)for(let j=y.length-1;j>=0;j--)dp[i][j]=x[i]===y[j]?1+dp[i+1][j+1]:Math.max(dp[i+1][j],dp[i][j+1]);let i=0,j=0;while(i<x.length||j<y.length){if(i<x.length&&j<y.length&&x[i]===y[j]){add('same',x[i]);i++;j++;}else if(i<x.length&&(j===y.length||dp[i+1][j]>=dp[i][j+1]))add('delete',x[i++]);else add('insert',y[j++]);}}
 add('same',end?a.slice(a.length-end).join(''):'');return out;
}
