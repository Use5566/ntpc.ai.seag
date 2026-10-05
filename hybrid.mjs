import {createHash} from 'node:crypto';
const normalize=s=>s.normalize('NFKC').toLowerCase();
export function lexicalTerms(text){
 const tokens=new Set();
 for(const match of normalize(text).matchAll(/[a-z0-9]+(?:[-_.][a-z0-9]+)*|[\p{Script=Han}]+/gu)){
  const t=match[0];if(/^[a-z0-9]/.test(t)){if(t.length<=80)tokens.add(t);continue;}
  const c=[...t];if(c.length===1)tokens.add(t);for(let i=0;i<c.length-1;i++)tokens.add(c.slice(i,i+2).join(''));
 }
 return [...tokens];
}
const key=t=>createHash('sha256').update(t).digest('hex').slice(0,24);
export const keywordTokens=text=>lexicalTerms(text).map(key);
export function queryTokens(text){return keywordTokens(text).slice(0,30);}
// Bounded indexed candidate retrieval, not a full collection scan or BM25.
export function fuseResults(vectorRows,keywordRows,question,limit=5){
 const wanted=new Set(lexicalTerms(question));
 const lexical=keywordRows.map(r=>({r,score:lexicalTerms((r.fields.title?.stringValue||'')+' '+(r.fields.text?.stringValue||'')).filter(t=>wanted.has(t)).length})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.r.name.localeCompare(b.r.name)).map(x=>x.r);
 const candidates=new Map();
 for(const rows of [vectorRows,lexical])rows.forEach((row,i)=>{const old=candidates.get(row.name)||{row,score:0};old.score+=1/(60+i+1);candidates.set(row.name,old);});
 return [...candidates.values()].sort((a,b)=>b.score-a.score||a.row.name.localeCompare(b.row.name)).slice(0,limit).map(x=>x.row);
}
