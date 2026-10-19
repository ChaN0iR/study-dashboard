import assert from 'node:assert/strict';
import worker from './index.js';
import { authApi, progressApi } from './recall/auth.js';
const original=globalThis.fetch;
let network=0, writes=0, lookups=0;
globalThis.fetch=async()=>{network++;throw new Error('unexpected external call');};
const env={APP_KEY:'secret',NOTION_TOKEN:'offline',ALLOWED_ORIGIN:'https://pages.example'};
const request=(path,method='GET',body,headers={})=>new Request('https://app'+path,{method,body,headers});
try {
 for(const key of [undefined,'','wrong','secre','secretx']){
  const r=await worker.fetch(request('/api/state','GET',undefined,key===undefined?{}:{'x-app-key':key}),env);
  assert.equal(r.status,401);
 }
 assert.equal((await worker.fetch(request('/api/state'),{...env,APP_KEY:''})).status,500);
 for(const method of ['GET','POST','PUT','DELETE']){
  const r=await worker.fetch(request('/api/state',method,undefined,{origin:'https://evil.example'}),env);
  assert.equal(r.status,401);assert.equal(r.headers.get('access-control-allow-origin'),env.ALLOWED_ORIGIN);
 }
 const preflight=await worker.fetch(request('/api/note','OPTIONS',undefined,{origin:'https://evil.example'}),env);
 assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),env.ALLOWED_ORIGIN);
 assert.equal(preflight.headers.get('access-control-allow-headers'),'content-type, x-app-key');
 for(const [path,body] of [['/api/task/invalid',{}],['/api/lesson/invalid',{}],['/api/note',{}],['/api/note',{title:'x',subject:'invalid'}],['/api/note',{title:'x',lessonId:'invalid'}],['/api/focus',{action:'invalid'}],['/api/record',{hours:-1}],['/api/record',{'心情':'invalid'}]]){
  assert.equal((await worker.fetch(request(path,'POST',JSON.stringify(body),{'x-app-key':'secret'}),env)).status,400,path);
 }
 const db={prepare(sql){return {bind(...args){this.args=args;return this;},async first(){lookups++;return null;},async run(){writes++;return {};}};}};
 for(const path of ['/api/auth/login','/api/auth/register','/api/auth/logout']){
  for(const origin of [undefined,'https://evil.example','null']){
   const headers=origin===undefined?{}:{origin};
   assert.equal((await authApi(request(path,'POST','{}',headers),{DB:db},path)).status,403);
  }
  assert.equal((await authApi(request(path),{DB:db},path)).status,405);
 }
 for(const cookie of ['', 'rr_session=forged']){
  const r=await progressApi(request('/api/progress','GET',undefined,{cookie}),{DB:db});assert.equal(r.status,401);
 }
 assert.equal((await progressApi(request('/api/progress','PUT','{}',{origin:'https://app'}),{DB:db})).status,401);
 assert.equal((await progressApi(request('/api/progress','PUT','{}',{origin:'https://evil.example'}),{DB:db})).status,403);
 assert.equal((await worker.fetch(request('/api/grade','POST','{}',{'x-app-key':'secret'}),{...env,DB:db})).status,401);
 const broken={prepare(){throw new Error('sensitive DB path');}};
 const failure=await authApi(request('/api/auth/me','GET',undefined,{cookie:'rr_session=forged'}),{DB:broken},'/api/auth/me');
 assert.equal(failure.status,503);assert.deepEqual(await failure.json(),{code:'AUTH_STORAGE_ERROR'});
 assert.equal(network,0);assert.equal(writes,0);assert.ok(lookups>0);
}finally{globalThis.fetch=original;}
console.log('Authorization, CORS, origin and adverse write tests passed');
