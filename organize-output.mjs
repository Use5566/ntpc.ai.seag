import {parseResult,MAX_CHARS} from './core.js';
import {bodySections,validateSourceMap} from './knowledge.js';

const str={type:'STRING'};
const list=items=>({type:'ARRAY',items});
const obj=properties=>({type:'OBJECT',properties,required:Object.keys(properties)});
const ids=list(str);
// Structural constraints only; editing instructions remain in TXT files.
export function organizeSchema(){
 return obj({title:str,sections:list(obj({text:str,sourceIds:ids,kind:{type:'STRING',enum:['source','supplement']}})),
  metadata:obj({eventDate:str,contentType:str,topics:list(str,100),summary:str,limitations:list(str,100),domains:list(str,100),gradeBands:list(str,100),usageLicense:str,visibility:{type:'STRING',enum:['token_holders']}}),
  omissions:list(obj({id:str,sourceIds:ids,text:str,reason:str})),
  questions:list(obj({id:str,sourceIds:ids,question:str,context:str})),
  privacyCandidates:list(obj({id:str,sourceIds:ids,text:str,replacement:str,reason:str}),300),
  coverage:list(obj({sourceId:str,status:{type:'STRING',enum:['retained','merged','omitted','pending']},target:str}))
 });
}

export function parseOrganizeOutput(output,sources){
 const raw=JSON.parse(output);
 if(!raw||!Array.isArray(raw.privacyCandidates))throw Error('privacyCandidates 必須是陣列。');
 if(Object.hasOwn(raw,'sections')){
  if(Object.hasOwn(raw,'body')||Object.hasOwn(raw,'sourceMap')||!Array.isArray(raw.sections)||!raw.sections.length||raw.sections.length>3000)throw Error('整理稿段落結構不正確。');
  const texts=[],sourceMap=[];
  for(const section of raw.sections){
   if(!section||Object.keys(section).sort().join(',')!=='kind,sourceIds,text'||typeof section.text!=='string'||!section.text.trim()||section.text.length>MAX_CHARS)throw Error('整理稿段落內容不正確。');
   // Preserve every paragraph and the model's explicit source links, even when
   // a section contains headings or multiple blank-line-separated paragraphs.
   for(const part of bodySections(section.text.replace(/\r\n?/g,'\n').trim())){
    texts.push(part.text);
    sourceMap.push({sectionId:'S'+String(sourceMap.length+1).padStart(3,'0'),sourceIds:section.sourceIds,kind:section.kind});
   }
  }
  delete raw.sections;raw.body=texts.join('\n\n');raw.sourceMap=sourceMap;
 }
 const result=parseResult(JSON.stringify(raw),sources);
 validateSourceMap(result.body,result.sourceMap,sources);
 return result;
}
