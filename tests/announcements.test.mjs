import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { createStore } from '../server/store.mjs';
import { createAnnouncements } from '../server/announcements.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-announcements-'));
  const store = createStore(directory), app = express();
  for (const [id, role] of [['admin', 'admin'], ['member', 'user'], ['other', 'user']]) store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES(?,?,?,?,?,?)', id, id, `${id}@example.com`, 'unused-test', role, new Date().toISOString());
  app.use(express.json());
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const auth = (req, _res, next) => { req.user = store.get('SELECT * FROM users WHERE id=?', req.get('x-user') || ''); next(req.user ? undefined : fail(401, 'auth')); };
  const admin = (req, _res, next) => next(req.user.role === 'admin' ? undefined : fail(403, 'admin'));
  const csrf = (req, _res, next) => next(req.method === 'GET' || req.get('x-csrf-token') === 'test' ? undefined : fail(403, 'csrf'));
  createAnnouncements({ store }).registerRoutes(app, { auth, admin, csrf });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  async function request(path, { user = 'admin', method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(base + path, { method, headers: { 'X-User': user, 'X-CSRF-Token': 'test', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  async function create(body = {}) { const result = await request('/api/admin/announcements', { method: 'POST', body: { title: '系统公告', body: '欢迎，支持 **Markdown**。', ...body } }); assert.equal(result.status, 201); return result.body.announcement; }
  return { request, create, store };
}

test('announcement publishing is admin-only and reads require authentication and CSRF', async t => {
  const f = await fixture(t), body = { title: '标题', body: '内容', status: 'published' };
  for (const path of ['/api/announcements', '/api/admin/announcements']) assert.equal((await f.request(path, { user: '' })).status, 401);
  assert.equal((await f.request('/api/admin/announcements', { user: 'member' })).status, 403);
  assert.equal((await f.request('/api/admin/announcements', { user: 'member', method: 'POST', body })).status, 403);
  assert.equal((await f.request('/api/admin/announcements', { method: 'POST', body, headers: { 'X-CSRF-Token': '' } })).status, 403);
  const value = await f.create({ status: 'published', authorId: 'other', revision: 999 });
  assert.equal(value.revision, 1); assert.equal(f.store.get('SELECT author_id FROM announcements WHERE id=?', value.id).author_id, 'admin');
  assert.equal((await f.request(`/api/admin/announcements/${value.id}`, { method: 'PATCH', user: 'member', body: { revision: 1, title: '恶意更改' } })).status, 403);
  assert.equal((await f.request(`/api/announcements/${value.id}/read`, { user: 'member', method: 'POST', body: { revision: 1 }, headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await f.request('/api/announcements', { user: 'member' })).headers.get('cache-control'), 'no-store');
});

test('drafts stay private and field validation rejects empty, oversized or invalid publications', async t => {
  const f = await fixture(t);
  for (const invalid of [{ title: '' }, { title: 'x'.repeat(121) }, { body: ' ' }, { body: 'x'.repeat(20001) }, { status: 'deleted' }, { title: {} }]) {
    const result = await f.request('/api/admin/announcements', { method: 'POST', body: { title: '标题', body: '内容', ...invalid } });
    assert.equal(result.status, 400);
  }
  const draft = await f.create();
  assert.equal(draft.status, 'draft'); assert.equal(draft.publishedAt, null);
  assert.equal((await f.request('/api/announcements', { user: 'member' })).body.announcements.length, 0);
  assert.equal((await f.request('/api/admin/announcements')).body.announcements.length, 1);
  assert.equal((await f.request(`/api/announcements/${draft.id}/read`, { user: 'member', method: 'POST', body: { revision: 1 } })).status, 404);
});

test('closing an announcement persists read state for that user across devices and keeps other users unread', async t => {
  const f = await fixture(t), value = await f.create({ status: 'published' });
  assert.equal((await f.request('/api/announcements', { user: 'member', headers: { 'User-Agent': 'phone' } })).body.announcements.length, 1);
  const path = `/api/announcements/${value.id}/read`;
  assert.equal((await f.request(path, { user: 'member', method: 'POST', body: { revision: 1, userId: 'other' } })).status, 200);
  assert.equal((await f.request('/api/announcements', { user: 'member', headers: { 'User-Agent': 'desktop' } })).body.announcements.length, 0);
  assert.equal((await f.request('/api/announcements', { user: 'other' })).body.announcements.length, 1);
  assert.equal((await f.request(path, { user: 'member', method: 'POST', body: { revision: 1 } })).status, 200);
  assert.equal(f.store.get('SELECT COUNT(*) AS count FROM announcement_reads').count, 1);
  assert.equal((await f.request(path, { user: 'other', method: 'POST', body: { revision: 2 } })).status, 409);
});

test('editing published content makes it unread and stale acknowledgements cannot dismiss the new revision', async t => {
  const f = await fixture(t), value = await f.create({ status: 'published' });
  await f.request(`/api/announcements/${value.id}/read`, { user: 'member', method: 'POST', body: { revision: 1 } });
  const edited = await f.request(`/api/admin/announcements/${value.id}`, { method: 'PATCH', body: { revision: 1, body: '更新后的内容' } });
  assert.equal(edited.status, 200); assert.equal(edited.body.announcement.revision, 2);
  assert.equal((await f.request('/api/announcements', { user: 'member' })).body.announcements[0].body, '更新后的内容');
  assert.equal((await f.request(`/api/announcements/${value.id}/read`, { user: 'member', method: 'POST', body: { revision: 1 } })).status, 409);
  assert.equal((await f.request(`/api/admin/announcements/${value.id}`, { method: 'PATCH', body: { revision: 1, title: '过时修改' } })).status, 409);
  const noChange = await f.request(`/api/admin/announcements/${value.id}`, { method: 'PATCH', body: { revision: 2, body: '更新后的内容' } });
  assert.equal(noChange.body.announcement.revision, 2);
  assert.equal((await f.request(`/api/announcements/${value.id}/read`, { user: 'member', method: 'POST', body: { revision: 2 } })).status, 200);
});

test('unpublishing removes announcements and republication has its own unread revision', async t => {
  const f = await fixture(t), value = await f.create({ status: 'published' });
  await f.request(`/api/announcements/${value.id}/read`, { user: 'member', method: 'POST', body: { revision: 1 } });
  const down = await f.request(`/api/admin/announcements/${value.id}`, { method: 'PATCH', body: { revision: 1, status: 'draft' } });
  assert.equal(down.body.announcement.revision, 2); assert.equal(down.body.announcement.status, 'draft');
  assert.equal((await f.request('/api/announcements', { user: 'other' })).body.announcements.length, 0);
  const up = await f.request(`/api/admin/announcements/${value.id}`, { method: 'PATCH', body: { revision: 2, status: 'published' } });
  assert.equal(up.body.announcement.revision, 3);
  assert.equal((await f.request('/api/announcements', { user: 'member' })).body.announcements[0].revision, 3);
});

test('concurrent admin edits cannot overwrite each other and Markdown is stored without execution', async t => {
  const f = await fixture(t), source = '# 标题\n\n<script>alert(1)</script>\n\n$\\frac{1}{2}$';
  const value = await f.create({ body: source, status: 'published' });
  const results = await Promise.all(['甲', '乙'].map(title => f.request(`/api/admin/announcements/${value.id}`, { method: 'PATCH', body: { revision: 1, title } })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const current = (await f.request('/api/announcements', { user: 'member' })).body.announcements[0];
  assert.equal(current.body, source); assert.equal(current.revision, 2);
});
