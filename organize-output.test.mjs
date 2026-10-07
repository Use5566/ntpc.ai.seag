import test from 'node:test';
import assert from 'node:assert/strict';
import {parseOrganizeOutput} from './organize-output.mjs';
const sources=[{id:'P001',text:'觀察。'},{id:'P002',text:'測量。'}];
const draft=()=>({title:'教學',sections:[{text:'觀察。',sourceIds:['P001'],kind:'source'}],metadata:{},omissions:[],questions:[],privacyCandidates:[],coverage:[]});
test('缺少可推導去向不使整份失敗；未對應原稿列入問題',()=>{const r=parseOrganizeOutput(JSON.stringify(draft()),sources);assert.equal(r.coverage.length,2);assert.equal(r.coverage[0].status,'retained');assert.equal(r.coverage[1].status,'pending');assert.deepEqual(r.questions[0].sourceIds,['P002']);});
test('接受程式碼圍欄、重複與字串來源編號及省略選填資料',()=>{const d=draft();d.sections[0].sourceIds='p001, P001';delete d.sections[0].kind;delete d.metadata;delete d.privacyCandidates;const r=parseOrganizeOutput('```json\n'+JSON.stringify(d)+'\n```',sources);assert.deepEqual(r.sourceMap[0].sourceIds,['P001']);assert.equal(r.metadata.visibility,'token_holders');});
test('未知來源與不在原文的去識別候選仍不可接受',()=>{const d=draft();d.sections[0].sourceIds=['P999'];assert.throws(()=>parseOrganizeOutput(JSON.stringify(d),sources));const p=draft();p.privacyCandidates=[{id:'D001',sourceIds:['P001'],text:'無根據姓名',replacement:'[識別D001]',reason:'人名'}];assert.throws(()=>parseOrganizeOutput(JSON.stringify(p),sources));});
test('禁止身分欄位不可因預設 metadata 而消失',()=>{const d=draft();d.metadata.hostOrganization='禁止';assert.throws(()=>parseOrganizeOutput(JSON.stringify(d),sources));});
