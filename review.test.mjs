import test from 'node:test';import assert from 'node:assert/strict';
import {reviewRows,commitRows,changes,cleanReferences} from './review.js';
import {validateSourceMap} from './knowledge.js';
test('來源代碼僅移除已知來源，保留一般括號',()=>{assert.equal(cleanReferences('標題 [P001, P002] [P999] [物理]',[{id:'P001'},{id:'P002'}]),'標題 [P999] [物理]');});
test('編輯、拆段、刪除及補充仍產生有效對照',()=>{const sources=[{id:'P001',text:'底稿'}];const rows=reviewRows({body:'標題 [P001]\n內容',sourceMap:[{sectionId:'S001',sourceIds:['P001'],kind:'source'}]},sources);rows[0].text='新標題\n\n新內容';rows.push({text:'事後補充',kind:'supplement',sourceIds:['P001']});const result=commitRows(rows);validateSourceMap(result.body,result.sourceMap,sources);assert.equal(result.sourceMap.length,3);assert.deepEqual(result.sourceMap[2].sourceIds,[]);rows[0].text='';assert.equal(commitRows(rows).body,'事後補充');});
test('修訂顯示可還原修改前後文字，含多處編輯與 emoji',()=>{for(const [a,b]of [['教學步驟需拆分。先提問再說明。','教學活動需拆分。先觀察再說明。'],['甲😀乙','甲🌟乙'],['','新增'],['刪除',''],['相同','相同']]){const d=changes(a,b);assert.equal(d.filter(p=>p.kind!=='insert').map(p=>p.text).join(''),a);assert.equal(d.filter(p=>p.kind!=='delete').map(p=>p.text).join(''),b);}});
