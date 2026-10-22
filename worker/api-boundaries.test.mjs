import assert from 'node:assert/strict';
import worker from './index.js';
import { readLimitedText, BodyTooLarge } from './request-body.js';
import { authApi } from './recall/auth.js';
import { grade } from './recall/worker.js';
const original = globalThis.fetch;
let calls = 0;
globalThis.fetch = async () => { calls++; throw new Error('private-token internal-stack'); };
try {
  const env = { APP_KEY: 'test', NOTION_TOKEN: 'test' };
  const send = (path, body, headers = {}) => worker.fetch(new Request('https://app'+path, {method:'POST', headers:{'x-app-key':'test', ...headers}, body}),env);
  for (const headers of [{}, {'content-length':'1'}]) {
    assert.equal((await send('/api/note', ' '.repeat(12_000_001), headers)).status,413);
  }
  assert.equal((await send('/api/note','{}',{'content-length':'12000001'})).status,413);
  assert.equal(calls,0);
  for (const raw of ['{', 'null', '[]', 'true', '3']) assert.equal((await send('/api/note',raw)).status,400);
  const failure = await send('/api/note',JSON.stringify({title:'valid'}));
  assert.equal(failure.status,502); assert.equal((await failure.json()).code,'NOTE_CREATE_UNCERTAIN');
  globalThis.fetch = async () => new Response(JSON.stringify({message:'private Notion details'}),{status:400});
  const upstream = await send('/api/note',JSON.stringify({title:'valid'}));
  assert.equal(upstream.status,502); const safe = await upstream.json(); assert.equal(safe.code,'NOTE_CREATE_UNCERTAIN'); assert.doesNotMatch(safe.error,/private|token|stack/);
  assert.equal(await readLimitedText(new Request('https://app',{method:'POST',body:'中'}),3),'中');
  await assert.rejects(readLimitedText(new Request('https://app',{method:'POST',body:'中'}),2),BodyTooLarge);
  let cancelled=false;
  const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(4));},cancel(){cancelled=true;}});
  await assert.rejects(readLimitedText(new Request('https://app',{method:'POST',body:stream,duplex:'half'}),3),BodyTooLarge);
  assert.equal(cancelled,true);
  const db={prepare(){throw new Error('DB must not be touched');}};
  const auth=await authApi(new Request('https://app/api/auth/login',{method:'POST',headers:{origin:'https://app'},body:JSON.stringify({password:'中'.repeat(3000)})}),{DB:db},'/api/auth/login');
  assert.equal(auth.status,413);
  const graded=await grade(new Request('https://app/api/grade',{method:'POST',body:JSON.stringify({question:'中'.repeat(220000)})}),{});
  // The disabled endpoint returns before parsing even oversized grading bodies.
  // Active note/auth routes and the streaming reader retain their byte-limit checks above.
  assert.equal(graded.status,503);
  assert.deepEqual(await graded.json(),{code:'AI_GRADING_DISABLED'});
} finally {globalThis.fetch=original;}
console.log('API error and byte limit tests passed');
