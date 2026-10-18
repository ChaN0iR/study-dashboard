import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('./recall-room.js', import.meta.url), 'utf8');
function run(base, saved) {
  const attributes = { 'aria-disabled': 'true' };
  const link = { setAttribute(k,v) {attributes[k]=v;}, removeAttribute(k) {delete attributes[k];} };
  const status = {};
  vm.runInNewContext(source, { URL, window: {CONFIG:{API_BASE:base}}, localStorage:{getItem:k => k==='apiBase' ? saved : 'private-app-key'}, document:{getElementById:id => id==='recall-room-open' ? link : id==='recall-room-status' ? status : null} });
  return {link,status,attributes};
}
test('recall opens on Worker origin without secrets or query strings', () => {
  const {link,attributes}=run('https://api.example/');
  assert.equal(link.href,'https://api.example/recall/'); assert.ok(!('aria-disabled' in attributes));
});
test('respects configured API override and strips private query', () => {
  assert.equal(run('https://old.example','https://new.example/base?key=secret').link.href,'https://new.example/recall/');
});
test('rejects dangerous URLs and embedded credentials', () => {
  for(const value of ['javascript:alert(1)','http://remote.example','https://user:password@example.com','not a url']) {
    const result=run(value); assert.equal(result.link.href,undefined); assert.equal(result.attributes['aria-disabled'],'true');
  }
});
test('supports loopback development', () => assert.equal(run('http://127.0.0.1:8787').link.href,'http://127.0.0.1:8787/recall/'));
