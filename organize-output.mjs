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
 const raw=JSON.parse(output.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
 normalizeOutput(raw,sources);
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

// Normalize transport details only. Unknown source IDs and ungrounded privacy
// candidates still pass through the strict validator and are never discarded.
function normalizeOutput(raw,sources){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('結果必須是物件。');
 for(const key of ['omissions','questions','privacyCandidates'])if(raw[key]==null)raw[key]=[];
 const defaults={eventDate:'',contentType:'整理稿',topics:[],summary:'',limitations:[],domains:[],gradeBands:[],usageLicense:'',visibility:'token_holders'};
 if(raw.metadata==null)raw.metadata={};
 for(const [key,value] of Object.entries(defaults))if(raw.metadata[key]==null)raw.metadata[key]=value;
 const canonical=new Map(sources.map(s=>[s.id.toUpperCase(),s.id]));
 const normalizeIds=value=>{
  if(typeof value==='string')value=value.split(/[,，、\s]+/).filter(Boolean);
  if(!Array.isArray(value))return value;
  return [...new Set(value.map(id=>typeof id==='string'?(canonical.get(id.trim().toUpperCase())||id.trim()):id))];
 };
 for(const list of [raw.sections,raw.sourceMap,raw.omissions,raw.questions,raw.privacyCandidates]){
  if(!Array.isArray(list))continue;
  for(const item of list){if(!item||typeof item!=='object')continue;item.sourceIds=normalizeIds(item.sourceIds);}
 }
 for(const item of raw.sections||[])if(item.kind==null)item.kind='source';
 // Coverage is a derived index, not another model-generated copy of the links.
 const map=raw.sections||raw.sourceMap;
 if(!Array.isArray(map)||!Array.isArray(raw.questions)||!Array.isArray(raw.omissions))return;
 let next=1;
 const used=new Set(raw.omissions.map(o=>o.id));
 let unmatched;
 raw.coverage=sources.map(source=>{
  const question=raw.questions.find(q=>q.sourceIds?.includes(source.id));
  if(question)return {sourceId:source.id,status:'pending',target:question.id};
  const linked=map.find(m=>m.kind!=='supplement'&&m.sourceIds?.includes(source.id));
  if(linked)return {sourceId:source.id,status:'retained',target:'整理稿來源對照'};
  const omission=raw.omissions.find(o=>o.sourceIds?.includes(source.id));
  if(omission)return {sourceId:source.id,status:'omitted',target:omission.id};
  if(!unmatched){
   let id;do{id='O'+String(next++).padStart(3,'0');}while(used.has(id));used.add(id);
   unmatched={id,sourceIds:[],text:'以下原稿未納入整理稿，合併列出供核對。',reason:'系統彙整未建立對照的原稿；不代表已判定沒有知識價值。完整內容仍保留於底稿，可恢復。'};
   raw.omissions.push(unmatched);
  }
  unmatched.sourceIds.push(source.id);
  return {sourceId:source.id,status:'omitted',target:unmatched.id};
 });
}
