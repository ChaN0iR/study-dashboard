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
 // Exercise the real session hashing and expiry query with a deterministic clock.
 const realNow=Date.now; Date.now=()=>1000;
 const token='valid-session';
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
 const hash=Buffer.from(digest).toString('base64url');
 let expiresAt=1001;
 const sessionDb={prepare(sql){return {bind(...args){this.args=args;return this;},async first(){
  if(sql.includes('JOIN users')){
   assert.match(sql,/sessions.expires_at > \?/);
   return this.args[0]===hash && expiresAt>this.args[1]?{id:'user-1',email:'offline@example.test'}:null;
  }
  return null;
 },async run(){throw new Error('unexpected session write');}};}};
 try {
  const me=()=>authApi(request('/api/auth/me','GET',undefined,{cookie:'rr_session='+token}),{DB:sessionDb},'/api/auth/me');
  assert.equal((await (await me()).json()).authenticated,true);
  expiresAt=1000; assert.equal((await (await me()).json()).authenticated,false);
  expiresAt=999; assert.equal((await (await me()).json()).authenticated,false);
  expiresAt=1001;
  const over=await progressApi(request('/api/progress','PUT','中'.repeat(140000),{origin:'https://app',cookie:'rr_session='+token}),{DB:sessionDb});
  assert.equal(over.status,413);
  const invalid=await progressApi(request('/api/progress','PUT','[]',{origin:'https://app',cookie:'rr_session='+token}),{DB:sessionDb});
  assert.equal(invalid.status,400);
 } finally {Date.now=realNow;}
 const broken={prepare(){throw new Error('sensitive DB path');}};
 const failure=await authApi(request('/api/auth/me','GET',undefined,{cookie:'rr_session=forged'}),{DB:broken},'/api/auth/me');
 assert.equal(failure.status,503);assert.deepEqual(await failure.json(),{code:'AUTH_STORAGE_ERROR'});
 assert.equal(network,0);assert.equal(writes,0);assert.ok(lookups>0);
}finally{globalThis.fetch=original;}
console.log('Authorization, CORS, origin and adverse write tests passed');
