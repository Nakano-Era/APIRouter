import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { createStore, digest } from '../server/store.mjs';
import { deviceName } from '../server/sessions.mjs';

const password = 'multi-device-fixture-password';
const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
const phone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';

async function fixture(t, { seed } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-multi-device-'));
  seed?.(directory);
  const instance = createApp({ dataDir: directory, setupToken: 'local-fixture-only', logger: { error() {} } });
  const server = createServer(instance.app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    instance.abortAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); instance.close();
    const path = realpathSync(directory); assert.ok(path.startsWith(realpathSync(tmpdir()) + sep) && path.includes('apirouter-multi-device-')); rmSync(path, { recursive: true, force: true });
  });
  async function request(path, { session, method = 'GET', body, csrf = true, headers = {} } = {}) {
    const response = await fetch(base + path, { method, headers: {
      ...(session ? { Cookie: session.cookie, ...(csrf ? { 'X-CSRF-Token': session.csrfToken } : {}) } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), response, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const login = async (email = 'admin@example.com', options = {}) => {
    const result = await request('/api/auth/login', { method: 'POST', body: { email, password }, ...options });
    assert.equal(result.status, 200); return { ...result.data, cookie: result.cookie };
  };
  let admin;
  if (!seed) {
    const result = await request('/api/auth/setup', { method: 'POST', headers: { 'User-Agent': desktop }, body: { name: 'Admin', email: 'admin@example.com', password, setupToken: 'local-fixture-only' } });
    assert.equal(result.status, 201); admin = { ...result.data, cookie: result.cookie };
    const user = instance.store.get('SELECT * FROM users WHERE id=?', admin.user.id);
    instance.store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES (?,?,?,?,?,?)', 'member', 'Member', 'member@example.com', user.password, 'user', new Date().toISOString());
  }
  return { request, login, admin, instance, directory };
}

test('independent device cookies and CSRF tokens remain valid and share account history', async t => {
  const f = await fixture(t), mobile = await f.login(undefined, { headers: { 'User-Agent': phone } });
  assert.notEqual(mobile.cookie, f.admin.cookie); assert.notEqual(mobile.csrfToken, f.admin.csrfToken);
  const result = await f.request('/api/auth/sessions', { session: f.admin });
  assert.equal(result.status, 200); assert.equal(result.data.sessions.length, 2);
  const [current, other] = result.data.sessions;
  assert.equal(current.current, true); assert.equal(current.deviceName, 'Chrome · Windows');
  assert.equal(other.current, false); assert.equal(other.deviceName, 'Safari · iOS');
  for (const row of result.data.sessions) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'deviceName', 'createdAt', 'lastSeenAt', 'expiresAt', 'current'].sort());
    assert.match(row.id, /^[a-f0-9]{32}$/); assert.ok(Number.isFinite(Date.parse(row.createdAt)));
    assert.ok(Date.parse(row.expiresAt) > Date.parse(row.lastSeenAt));
    assert.ok(!JSON.stringify(row).includes(mobile.csrfToken) && !JSON.stringify(row).includes(f.admin.csrfToken));
    assert.notEqual(row.id, digest(mobile.cookie.split('=')[1]));
  }
  assert.equal((await f.request('/api/chats', { session: mobile, method: 'POST', body: { title: '手机创建的对话' }, headers: { 'X-CSRF-Token': f.admin.csrfToken } })).status, 403);
  const chat = await f.request('/api/chats', { session: mobile, method: 'POST', body: { title: '手机创建的对话' } });
  assert.equal(chat.status, 201);
  assert.equal((await f.request(`/api/chats/${chat.data.chat.id}`, { session: f.admin })).data.chat.title, '手机创建的对话');
  assert.equal((await f.request('/api/auth/logout', { session: mobile, method: 'POST' })).status, 200);
  assert.equal((await f.request('/api/chats', { session: mobile })).status, 401);
  assert.equal((await f.request('/api/chats', { session: f.admin })).status, 200);
});

test('reauthenticating one browser rotates only its cookie and keeps another device signed in', async t => {
  const f = await fixture(t), mobile = await f.login();
  const updated = await f.login(undefined, { session: f.admin });
  assert.notEqual(updated.cookie, f.admin.cookie);
  assert.equal((await f.request('/api/chats', { session: f.admin })).status, 401);
  assert.equal((await f.request('/api/chats', { session: mobile })).status, 200);
  assert.equal((await f.request('/api/auth/sessions', { session: updated })).data.sessions.length, 2);
  const switched = await f.login('member@example.com', { session: updated });
  assert.equal((await f.request('/api/chats', { session: updated })).status, 200, 'switching account does not revoke a different account session');
  assert.equal((await f.request('/api/auth/sessions', { session: switched })).data.sessions.length, 1);
});

test('session management rejects anonymous, cross-user and CSRF-less revocation', async t => {
  const f = await fixture(t), member = await f.login('member@example.com');
  const own = (await f.request('/api/auth/sessions', { session: f.admin })).data.sessions[0];
  const foreign = (await f.request('/api/auth/sessions', { session: member })).data.sessions[0];
  for (const [path, method] of [['/api/auth/sessions', 'GET'], [`/api/auth/sessions/${own.id}`, 'DELETE'], ['/api/auth/sessions/logout-others', 'POST']]) {
    assert.equal((await f.request(path, { method })).status, 401);
    if (method !== 'GET') assert.equal((await f.request(path, { session: f.admin, method, csrf: false })).status, 403);
  }
  assert.equal((await f.request(`/api/auth/sessions/${foreign.id}`, { session: f.admin, method: 'DELETE' })).status, 404);
  assert.equal((await f.request(`/api/auth/sessions/${own.id}`, { session: member, method: 'DELETE' })).status, 404);
  assert.equal((await f.request('/api/auth/sessions/logout-others', { session: f.admin, method: 'POST', headers: { Origin: 'https://elsewhere.invalid' } })).status, 403);
  assert.equal((await f.request('/api/chats', { session: member })).status, 200);
  assert.equal((await f.request('/api/chats', { session: f.admin })).status, 200);
});

test('revoking another device preserves the current session; revoking self clears the cookie', async t => {
  const f = await fixture(t), mobile = await f.login();
  const rows = (await f.request('/api/auth/sessions', { session: f.admin })).data.sessions;
  const removed = await f.request(`/api/auth/sessions/${rows.find(row => !row.current).id}`, { session: f.admin, method: 'DELETE' });
  assert.deepEqual(removed.data, { ok: true, current: false }); assert.equal(removed.cookie, undefined);
  assert.equal((await f.request('/api/chats', { session: mobile })).status, 401);
  assert.equal((await f.request('/api/chats', { session: f.admin })).status, 200);
  const loggedOut = await f.request(`/api/auth/sessions/${rows.find(row => row.current).id}`, { session: f.admin, method: 'DELETE' });
  assert.deepEqual(loggedOut.data, { ok: true, current: true }); assert.equal(loggedOut.cookie, 'apirouter_session=');
  assert.match(loggedOut.response.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await f.request('/api/chats', { session: f.admin })).status, 401);
});

test('logout others excludes expired sessions and does not affect another account', async t => {
  const f = await fixture(t), mobile = await f.login(), third = await f.login(), member = await f.login('member@example.com');
  f.instance.store.run('INSERT INTO sessions(token,user_id,csrf,expires_at) VALUES (?,?,?,?)', 'expired', f.admin.user.id, 'unused', '2000-01-01T00:00:00.000Z');
  assert.equal((await f.request('/api/auth/sessions', { session: f.admin })).data.sessions.length, 3);
  const result = await f.request('/api/auth/sessions/logout-others', { session: f.admin, method: 'POST' });
  assert.deepEqual(result.data, { ok: true, revokedCount: 2 });
  for (const session of [mobile, third]) assert.equal((await f.request('/api/chats', { session })).status, 401);
  for (const session of [f.admin, member]) assert.equal((await f.request('/api/chats', { session })).status, 200);
  assert.deepEqual((await f.request('/api/auth/sessions/logout-others', { session: f.admin, method: 'POST' })).data, { ok: true, revokedCount: 0 });
});

test('password changes revoke other devices and account disable revokes all of that user', async t => {
  const f = await fixture(t), mobile = await f.login(), member = await f.login('member@example.com'), memberOther = await f.login('member@example.com');
  const result = await f.request('/api/auth/password', { session: f.admin, method: 'POST', body: { currentPassword: password, newPassword: 'replacement-fixture-password' } });
  assert.equal(result.status, 200);
  assert.equal((await f.request('/api/chats', { session: mobile })).status, 401);
  assert.equal((await f.request('/api/chats', { session: f.admin })).status, 200);
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { email: 'admin@example.com', password } })).status, 401);
  assert.equal((await f.request('/api/admin/users/member', { session: f.admin, method: 'PATCH', body: { disabled: true } })).status, 200);
  for (const session of [member, memberOther]) assert.equal((await f.request('/api/chats', { session })).status, 401);
  assert.equal(f.instance.store.get('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?', 'member').count, 0);
});

test('last seen is throttled while device labels contain only coarse browser and OS categories', async t => {
  const f = await fixture(t), token = digest(f.admin.cookie.split('=')[1]);
  const before = f.instance.store.get('SELECT * FROM sessions WHERE token=?', token);
  await f.request('/api/auth/session', { session: f.admin });
  assert.equal(f.instance.store.get('SELECT last_seen_at FROM sessions WHERE token=?', token).last_seen_at, before.last_seen_at);
  const stale = new Date(Date.now() - 120_000).toISOString();
  f.instance.store.run('UPDATE sessions SET last_seen_at=? WHERE token=?', stale, token);
  await f.request('/api/auth/session', { session: f.admin, headers: { 'User-Agent': 'private-user-data' } });
  const after = f.instance.store.get('SELECT * FROM sessions WHERE token=?', token);
  assert.ok(after.last_seen_at > stale); assert.equal(after.device_label, 'Chrome · Windows');
  await f.request('/api/auth/sessions', { session: f.admin });
  assert.equal(f.instance.store.get('SELECT last_seen_at FROM sessions WHERE token=?', token).last_seen_at, after.last_seen_at);
  assert.equal(deviceName('unrecognized sensitive data'), '未知设备');
  assert.equal(deviceName(`${desktop} Edg/130.0`), 'Edge · Windows');
  assert.equal(deviceName('Mozilla Android Chrome/130.0'), 'Chrome · Android');
  assert.equal(deviceName('Mozilla Macintosh Firefox/130.0'), 'Firefox · macOS');
});

test('legacy session migration preserves authentication and stable opaque IDs across restarts', async t => {
  const token = randomBytes(32).toString('base64url'), expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  let publicId;
  const f = await fixture(t, { seed(directory) {
    const db = new DatabaseSync(join(directory, 'app.sqlite'));
    db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE,password TEXT,role TEXT,disabled INTEGER DEFAULT 0,daily_limit INTEGER,created_at TEXT); CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id TEXT,csrf TEXT,expires_at TEXT);');
    db.prepare('INSERT INTO users(id,name,email,password,role,created_at) VALUES (?,?,?,?,?,?)').run('legacy', 'Legacy', 'legacy@example.com', 'unused', 'user', new Date().toISOString());
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(digest(token), 'legacy', 'legacy-csrf', expiresAt); db.close();
    const first = createStore(directory), row = first.get('SELECT * FROM sessions');
    publicId = row.public_id;
    assert.match(publicId, /^[a-f0-9]{32}$/); assert.notEqual(publicId, digest(token));
    assert.equal(row.expires_at, expiresAt); assert.equal(row.token, digest(token)); assert.equal(row.csrf, 'legacy-csrf');
    assert.equal(row.device_label, '原有设备'); first.close();
  } });
  const session = { cookie: `apirouter_session=${token}`, csrfToken: 'legacy-csrf' };
  const result = await f.request('/api/auth/sessions', { session });
  assert.equal(result.status, 200); assert.equal(result.data.sessions[0].id, publicId); assert.equal(result.data.sessions[0].current, true);
  assert.equal((await f.request('/api/chats', { session, method: 'POST', body: {} })).status, 201);
});
