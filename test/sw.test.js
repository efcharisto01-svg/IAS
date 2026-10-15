import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

function boot(windows = []) {
  const handlers = {}, shown = [], opened = [], log = { msgs: [], focused: 0, navigated: [] };
  const wins = windows.map((w) => ({ ...w, postMessage: (m) => log.msgs.push(m), focus: async () => { log.focused++; }, navigate: async (u) => { log.navigated.push(u); } }));
  const self = {
    addEventListener: (t, fn) => { handlers[t] = fn; },
    skipWaiting() {}, location: { origin: 'https://ias.example.com' },
    registration: { scope: 'https://ias.example.com/', showNotification: async (title, opt) => { shown.push({ title, ...opt }); } },
    clients: { claim: async () => {}, matchAll: async () => wins, openWindow: async (u) => { opened.push(u); } },
  };
  vm.runInNewContext(SRC, { self, URL, Promise });
  const run = async (type, event) => { let p; handlers[type]({ ...event, waitUntil: (x) => { p = x; } }); await p; };
  return { run, shown, opened, log };
}
const push = (obj) => ({ data: { json: () => obj } });

test('push with no IAS window open shows a device notification', async () => {
  const sw = boot([]);
  await sw.run('push', push({ id: 5, source: '게시판', title: '새 공지', body: '보안 점검', link: 'post.html?id=5' }));
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, '새 공지'); assert.equal(sw.shown[0].body, '게시판 · 보안 점검');
  assert.equal(sw.shown[0].tag, 'ias-5'); assert.equal(sw.shown[0].data.link, 'post.html?id=5');
  assert.equal(sw.shown[0].requireInteraction, undefined, 'how long it stays is left to the browser/OS');
});

test('when the user is looking at IAS the bell is refreshed instead of a device notification', async () => {
  const sw = boot([{ url: 'https://ias.example.com/home.html', visibilityState: 'visible', focused: true }]);
  await sw.run('push', push({ id: 6, title: 'x' }));
  assert.equal(sw.shown.length, 0); assert.equal(JSON.stringify(sw.log.msgs), JSON.stringify([{ type: 'ias-notify' }]));
});

test('hidden window: notification is shown and the page is told to refresh', async () => {
  const sw = boot([{ url: 'https://ias.example.com/home.html', visibilityState: 'hidden', focused: false }]);
  await sw.run('push', push({ id: 7, title: '숨은 탭' }));
  assert.equal(sw.shown.length, 1); assert.equal(sw.log.msgs.length, 1);
});

test('broken or empty payload does not crash and still shows something', async () => {
  const sw = boot([]);
  await sw.run('push', { data: { json: () => { throw new Error('bad'); } } });
  await sw.run('push', {});
  assert.equal(sw.shown.length, 2); assert.equal(sw.shown[0].title, 'IAS');
});

test('click opens the page; unsafe links fall back to the home page', async () => {
  const sw = boot([]);
  let closed = 0;
  await sw.run('notificationclick', { notification: { close: () => closed++, data: { link: 'post.html?id=5' } } });
  await sw.run('notificationclick', { notification: { close: () => closed++, data: { link: 'https://evil.example/x' } } });
  await sw.run('notificationclick', { notification: { close: () => closed++, data: { link: '//evil.example' } } });
  assert.deepEqual(sw.opened, ['https://ias.example.com/post.html?id=5', 'https://ias.example.com/home.html', 'https://ias.example.com/home.html']);
  assert.equal(closed, 3);
});

test('click reuses an open IAS window', async () => {
  const sw = boot([{ url: 'https://ias.example.com/home.html', visibilityState: 'hidden', focused: false }]);
  await sw.run('notificationclick', { notification: { close() {}, data: { link: 'post.html?id=9' } } });
  assert.equal(sw.log.focused, 1); assert.deepEqual(sw.log.navigated, ['https://ias.example.com/post.html?id=9']); assert.equal(sw.opened.length, 0);
});
