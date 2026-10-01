import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createStore } from '../server/store.mjs';
import { createUserModelAccess, usagePeriods } from '../server/user-model-access.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-model-limits-')), store = createStore(directory);
  const columns = new Set(store.all('PRAGMA table_info(requests)').map(row => row.name));
  if (!columns.has('route_key')) store.db.exec('ALTER TABLE requests ADD COLUMN route_key TEXT');
  if (!columns.has('variant_name')) store.db.exec("ALTER TABLE requests ADD COLUMN variant_name TEXT DEFAULT ''");
  let time = Date.parse('2026-10-01T04:00:00.000Z');
  for (const role of ['admin', 'user', 'other']) store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES(?,?,?,?,?,?)', role, role, `${role}@example.com`, 'password-must-not-export', role === 'admin' ? role : 'user', new Date(time).toISOString());
  const service = createUserModelAccess({ store, clock: () => time }), app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = store.get('SELECT * FROM users WHERE id=?', req.get('x-user') || ''); next(); });
  const fault = (status, message) => Object.assign(new Error(message), { status });
  const auth = (req, _res, next) => req.user ? next() : next(fault(401, 'auth'));
  const admin = (req, _res, next) => req.user.role === 'admin' ? next() : next(fault(403, 'admin'));
  const csrf = (req, _res, next) => req.get('x-csrf-token') === 'test' ? next() : next(fault(403, 'csrf'));
  service.registerRoutes(app, { auth, admin, csrf });
  const insert = ({ user = 'user', route = 'ChatGPT 6 Astra', variant = '', at = time, status = 'running', requestId = randomUUID() } = {}) => store.run('INSERT INTO requests(id,user_id,model_id,route_key,variant_name,status,created_at) VALUES(?,?,?,?,?,?,?)', requestId, user, 'public-model', route, variant, status, new Date(at).toISOString());
  app.post('/generate', auth, (req, res) => {
    store.transaction(() => { service.assertCanGenerate(req.user.id, req.body.route, req.body.variant); insert({ user: req.user.id, route: req.body.route, variant: req.body.variant }); });
    res.status(201).json({ ok: true });
  });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = async (path, { user = 'admin', method = 'GET', body, csrf = true } = {}) => {
    const response = await fetch(base + path, { method, headers: { 'x-user': user, 'x-csrf-token': csrf ? 'test' : '', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { store, service, request, insert, setTime: value => { time = Date.parse(value); } };
}
const rule = (extra = {}) => ({ routeKey: 'ChatGPT 6 Astra', variantName: '', dailyLimit: null, monthlyLimit: null, ...extra });

test('model limits use Taipei natural day and month boundaries including year rollover', () => {
  assert.deepEqual(usagePeriods('2026-12-31T16:00:00.000Z'), { timeZone: 'Asia/Taipei', dayStart: '2026-12-31T16:00:00.000Z', dayEnd: '2027-01-01T16:00:00.000Z', monthStart: '2026-12-31T16:00:00.000Z', monthEnd: '2027-01-31T16:00:00.000Z' });
  assert.equal(usagePeriods('2026-09-30T15:59:59.999Z').monthEnd, '2026-09-30T16:00:00.000Z');
});

test('only administrators can read or replace user model limits and writes require CSRF', async t => {
  const f = await fixture(t), path = '/api/admin/users/user/model-limits';
  assert.equal((await f.request(path, { user: '' })).status, 401);
  assert.equal((await f.request(path, { user: 'user' })).status, 403);
  assert.equal((await f.request(path, { method: 'PUT', user: 'user', body: { limits: [] } })).status, 403);
  assert.equal((await f.request(path, { method: 'PUT', csrf: false, body: { limits: [] } })).status, 403);
  assert.equal((await f.request('/api/admin/users/missing/model-limits')).status, 404);
  const saved = await f.request(path, { method: 'PUT', body: { limits: [rule({ dailyLimit: 5 })] } });
  assert.equal(saved.status, 200); assert.equal(saved.body.limits[0].dailyLimit, 5); assert.equal(saved.body.timeZone, 'Asia/Taipei');
});

test('limits are validated atomically and null aliases only the empty default version', async t => {
  const f = await fixture(t), path = '/api/admin/users/user/model-limits';
  f.service.replaceLimits('user', [rule({ variantName: null, dailyLimit: 6 }), rule({ variantName: '普通版', monthlyLimit: 2 })]);
  const invalid = [undefined, [rule({ dailyLimit: -1 })], [rule({ dailyLimit: 1.5 })], [rule({ monthlyLimit: '3' })], [rule({ routeKey: ' ' })], [rule(), rule({ variantName: null })], [rule({ variantName: {} })], [rule({ variantName: 'a'.repeat(101) })]];
  for (const limits of invalid) assert.equal((await f.request(path, { method: 'PUT', body: { limits } })).status, 400);
  assert.equal(f.service.listLimits('user').limits.length, 2);
  const saved = await f.request(path, { method: 'PUT', body: { limits: [] } });
  assert.equal(saved.status, 200); assert.deepEqual(saved.body.limits, []);
});

test('versions have independent counters for all outcomes and never consume another version or user quota', async t => {
  const f = await fixture(t);
  f.service.replaceLimits('user', [rule({ variantName: '普通版', dailyLimit: 2 }), rule({ variantName: '高智商版', monthlyLimit: 2 })]);
  f.insert({ variant: '高智商版', status: 'error' }); f.insert({ variant: '高智商版', status: 'stopped' });
  const scopes = f.service.listLimits('user').limits;
  assert.equal(scopes.find(value => value.variantName === '高智商版').usedToday, 2);
  assert.equal(scopes.find(value => value.variantName === '普通版').usedToday, 0);
  assert.throws(() => f.service.assertCanGenerate('user', 'ChatGPT 6 Astra', '高智商版'), { code: 'USER_MODEL_MONTHLY_LIMIT', status: 429 });
  assert.doesNotThrow(() => f.service.assertCanGenerate('user', 'ChatGPT 6 Astra', '普通版'));
  assert.doesNotThrow(() => f.service.assertCanGenerate('other', 'ChatGPT 6 Astra', '高智商版'));
  assert.doesNotThrow(() => f.service.assertCanGenerate('user', 'Other model', '高智商版'));
  f.insert({ variant: '普通版', status: 'complete' }); f.insert({ variant: '普通版', status: 'interrupted' });
  assert.throws(() => f.service.assertCanGenerate('user', 'ChatGPT 6 Astra', '普通版'), { code: 'USER_MODEL_DAILY_LIMIT' });
  assert.equal(f.service.listLimits('user').limits.find(value => value.variantName === '高智商版').usedToday, 2);
  assert.doesNotThrow(() => f.service.assertCanGenerate('user', 'ChatGPT 6 Astra', ''));
});

test('zero disables an exact variant including for administrators and null leaves it unlimited', async t => {
  const f = await fixture(t);
  f.service.replaceLimits('admin', [rule({ variantName: '', dailyLimit: 0 })]);
  assert.throws(() => f.service.assertCanGenerate('admin', 'ChatGPT 6 Astra', ''), { code: 'USER_MODEL_DISABLED', status: 403 });
  assert.doesNotThrow(() => f.service.assertCanGenerate('admin', 'ChatGPT 6 Astra', '普通版'));
  f.service.replaceLimits('admin', [rule()]);
  for (let i = 0; i < 5; i++) f.insert({ user: 'admin' });
  assert.doesNotThrow(() => f.service.assertCanGenerate('admin', 'ChatGPT 6 Astra', ''));
});

test('old and future requests do not leak across usage periods and snapshots survive model removal', async t => {
  const f = await fixture(t);
  f.service.replaceLimits('user', [rule({ dailyLimit: 1, monthlyLimit: 2 })]);
  f.insert({ at: '2026-09-30T15:59:59.999Z' }); // September in Taipei.
  f.insert({ at: '2026-10-31T16:00:00.000Z' }); // November in Taipei.
  assert.equal(f.service.listLimits('user').limits[0].usedMonth, 0);
  f.insert({ at: '2026-09-30T16:00:00.000Z' }); // October 1 midnight.
  assert.throws(() => f.service.assertCanGenerate('user', 'ChatGPT 6 Astra', ''), { code: 'USER_MODEL_DAILY_LIMIT' });
  f.setTime('2026-10-01T16:00:00.000Z');
  assert.equal(f.service.listLimits('user').limits[0].usedToday, 0);
  assert.equal(f.service.listLimits('user').limits[0].usedMonth, 1);
  assert.doesNotThrow(() => f.service.assertCanGenerate('user', 'ChatGPT 6 Astra', ''));
});

test('concurrent reservations cannot overrun a model quota when assertion and insertion share one transaction', async t => {
  const f = await fixture(t);
  f.service.replaceLimits('user', [rule({ variantName: '普通版', dailyLimit: 3 })]);
  const results = await Promise.all(Array.from({ length: 12 }, () => f.request('/generate', { method: 'POST', user: 'user', body: { route: 'ChatGPT 6 Astra', variant: '普通版' } })));
  assert.equal(results.filter(result => result.status === 201).length, 3);
  assert.equal(results.filter(result => result.status === 429 && result.body.code === 'USER_MODEL_DAILY_LIMIT').length, 9);
  assert.equal(f.service.listLimits('user').limits[0].usedToday, 3);
});

test('legacy shared limits migrate into independent version rules while preserving exact overrides', async t => {
  const f = await fixture(t);
  f.store.run('INSERT INTO providers(id,name,base_url,protocol,encrypted_key,key_hint,created_at) VALUES(?,?,?,?,?,?,?)', 'p', 'provider', 'https://provider.invalid', 'openai-chat', 'secret', 'hint', '2026-10-01T04:00:00.000Z');
  for (const variant of ['高智商版', '普通版']) f.store.run('INSERT INTO models(id,provider_id,model_id,name,route_key,variant_name) VALUES(?,?,?,?,?,?)', variant, 'p', variant, variant, 'ChatGPT 6 Astra', variant);
  f.service.replaceLimits('user', [rule({ variantName: '高智商版', dailyLimit: 7 })]);
  f.store.run('INSERT INTO user_model_limits(user_id,route_key,scope_key,variant_name,daily_limit,monthly_limit,updated_at) VALUES(?,?,?,?,?,?,?)', 'user', 'ChatGPT 6 Astra', 'null', null, 2, 10, '2026-10-01T04:00:00.000Z');
  const migrated = createUserModelAccess({ store: f.store, clock: () => Date.parse('2026-10-01T04:00:00.000Z') });
  const limits = migrated.listLimits('user').limits;
  assert.equal(limits.length, 2); assert.ok(limits.every(value => typeof value.variantName === 'string'));
  assert.equal(limits.find(value => value.variantName === '高智商版').dailyLimit, 7);
  assert.equal(limits.find(value => value.variantName === '普通版').dailyLimit, 2);
  f.insert({ variant: '普通版' }); f.insert({ variant: '普通版' });
  assert.throws(() => migrated.assertCanGenerate('user', 'ChatGPT 6 Astra', '普通版'), { code: 'USER_MODEL_DAILY_LIMIT' });
  assert.doesNotThrow(() => migrated.assertCanGenerate('user', 'ChatGPT 6 Astra', '高智商版'));
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM user_model_limits WHERE variant_name IS NULL').n, 0);
});

test('failed generation transaction rolls back the reservation and route attempts do not consume extra quota', async t => {
  const f = await fixture(t);
  f.service.replaceLimits('user', [rule({ dailyLimit: 1 })]);
  assert.throws(() => f.store.transaction(() => { f.service.assertCanGenerate('user', 'ChatGPT 6 Astra', ''); f.insert(); throw new Error('rollback'); }), /rollback/);
  assert.equal(f.service.listLimits('user').limits[0].usedToday, 0);
  f.insert({ requestId: 'one-request' });
  for (let i = 0; i < 5; i++) f.store.run('INSERT INTO route_attempts(id,request_id,outcome,created_at) VALUES(?,?,?,?)', `attempt-${i}`, 'one-request', 'error', '2026-10-01T04:00:00.000Z');
  assert.equal(f.service.listLimits('user').limits[0].usedToday, 1);
});
