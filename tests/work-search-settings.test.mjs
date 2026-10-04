import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createStore } from '../server/store.mjs';
import { createWorkService } from '../server/work.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-search-settings-')), store = createStore(directory), calls = [], jobs = [];
  const stamp = new Date().toISOString();
  for (const user of ['admin', 'owner']) store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES(?,?,?,?,?,?)', user, user, `${user}@example.com`, 'unused', user === 'admin' ? 'admin' : 'user', stamp);
  store.run('INSERT INTO chats(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)', 'chat', 'owner', '搜索', stamp, stamp);
  const service = createWorkService({ store, runnerUrl: 'http://runner:3210', runnerToken: 'a'.repeat(43),
    webAccess: { async search(input, options) { calls.push({ input, options }); return { query: input.query, results: [{ title: '公开资料', url: 'https://example.com/', snippet: '最新数据' }], retrievedAt: stamp }; } },
    async fetcher(url, options) {
      if (url.endsWith('/health')) return Response.json({ available: true });
      jobs.push(JSON.parse(options.body));
      return new Response('{"type":"delta","text":"资料已读取"}\n{"type":"done"}\n');
    }
  });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = store.get('SELECT * FROM users WHERE id=?', req.get('x-user') || ''); next(); });
  const auth = (req, res, next) => req.user ? next() : res.sendStatus(401);
  const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.sendStatus(403);
  const csrf = (req, res, next) => req.get('x-csrf-token') === 'test' ? next() : res.sendStatus(403);
  service.registerRoutes(app, { auth, admin, csrf });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); const path = realpathSync(directory); assert.ok(path.startsWith(realpathSync(tmpdir()) + sep) && path.includes('apirouter-search-settings-')); rmSync(path, { recursive: true, force: true }); });
  const request = (path, { method = 'GET', body, user = 'admin', csrf = true } = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { 'x-user': user, ...(csrf ? { 'x-csrf-token': 'test' } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { store, service, calls, jobs, request };
}

test('Work search configuration and connectivity tests require admin auth and mutation CSRF and save atomically', async t => {
  const f = await fixture(t), path = '/api/admin/work/search';
  for (const user of ['', 'owner']) for (const [suffix, method, body] of [['', 'GET'], ['', 'PATCH', { enabled: false }], ['/test', 'POST', { query: '实时天气' }]]) {
    assert.equal((await f.request(path + suffix, { user, method, body })).status, user ? 403 : 401);
  }
  for (const [suffix, method, body] of [['', 'PATCH', { enabled: false }], ['/test', 'POST', {}]]) assert.equal((await f.request(path + suffix, { method, body, csrf: false })).status, 403);
  const before = await (await f.request(path)).json();
  for (const body of [{ enabled: 'yes' }, { baseUrl: 'http://127.0.0.1:8080' }, { baseUrl: 'https://10.0.0.1' }, { baseUrl: 'https://user:password@example.com' }, { baseUrl: 'http://work-search:8080/private' }, { unknown: true }]) {
    assert.equal((await f.request(path, { method: 'PATCH', body })).status, 400);
    assert.deepEqual(await (await f.request(path)).json(), before);
  }
  assert.equal((await f.request(path, { method: 'PATCH', body: { baseUrl: 'https://search.example.com/prefix/' } })).status, 200);
  const response = await f.request(path + '/test', { method: 'POST', body: { query: '公开公交实时数据' } });
  assert.equal(response.status, 200); assert.equal((await response.json()).results.length, 1);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].input, { query: '公开公交实时数据', limit: 5 }); assert.equal(f.calls[0].options.baseUrl, 'https://search.example.com/prefix'); assert.ok(f.calls[0].options.signal instanceof AbortSignal);
});

test('Work jobs receive the saved independent search config and disabled search stops before invoking the runner', async t => {
  const f = await fixture(t), path = '/api/admin/work/search';
  assert.equal((await f.request(path, { method: 'PATCH', body: { enabled: true, baseUrl: 'https://search.example.com' } })).status, 200);
  const options = { provider: { baseUrl: 'https://api.example.com', protocol: 'openai-chat', runtime: 'api', apiKey: 'fixture-key' }, model: { modelId: 'fixture-model' }, messages: [{ role: 'user', content: '搜索实时公交' }], mode: 'work', webSearch: true, context: { userId: 'owner', chatId: 'chat' } };
  for await (const _event of f.service.stream(options)) { /* Consume the complete local runner response. */ }
  assert.equal(f.jobs.length, 1); assert.deepEqual(f.jobs[0].search, { enabled: true, baseUrl: 'https://search.example.com' }); assert.equal(f.jobs[0].webSearch, true);
  assert.equal((await f.request(path, { method: 'PATCH', body: { enabled: false } })).status, 200);
  await assert.rejects(async () => { for await (const _event of f.service.stream(options)) { /* Should not run. */ } }, error => error.code === 'WEB_SEARCH_DISABLED');
  assert.equal(f.jobs.length, 1); assert.equal((await f.request(path + '/test', { method: 'POST', body: {} })).status, 400); assert.equal(f.calls.length, 0);
  const capabilities = await (await f.request('/api/work/capabilities', { user: 'owner' })).json(); assert.equal(capabilities.webSearchSupported, false);
});
