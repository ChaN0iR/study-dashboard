import test from 'node:test';
import assert from 'node:assert/strict';
import {validate,CANDIDATE,CHECKS} from './check-manual-acceptance.mjs';
const fixture=()=>({fixture:'pr39-mobile-v1',candidate:CANDIDATE,status:'PASS',stage:'complete',runId:'11111111-1111-4111-8111-111111111111',completedAt:'2026-10-26T05:00:00Z',userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X)',checks:Object.fromEntries(CHECKS.map(k=>[k,true]))});
test('complete evidence passes synthetic checks but cannot prove installed PWA or authorize release',()=>{
 const r=validate(fixture()); assert.equal(r.result,'SYNTHETIC_IPHONE_CHECKS_PASS');assert.match(r.installedPwa,/UNVERIFIED/);assert.equal(r.releaseAuthorization,'NOT_GRANTED');
});
test('each missing or nonboolean check fails closed',()=>{for(const key of CHECKS)for(const value of [undefined,false,'true',1]){const f=fixture();f.checks[key]=value;assert.equal(validate(f).result,'FAIL',key);}});
test('wrong candidate, incomplete, desktop, invalid identity, timestamp and stale error fail',()=>{for(const change of [{candidate:'other'},{stage:'online-pass'},{status:'FAIL'},{userAgent:'Chromium'},{runId:''},{completedAt:''},{error:'old failure'},{fixture:'other'}])assert.equal(validate({...fixture(),...change}).result,'FAIL');});
test('invalid input is rejected and unknown fields are not echoed',()=>{for(const f of [null,[],false])assert.equal(validate(f).result,'FAIL');assert.equal(JSON.stringify(validate({...fixture(),token:'DO-NOT-ECHO'})).includes('DO-NOT-ECHO'),false);});
