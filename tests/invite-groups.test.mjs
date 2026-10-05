import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { createStore } from '../server/store.mjs';
import { createBilling } from '../server/billing.mjs';
import { createUserModelRouting } from '../server/user-model-routing.mjs';
import { createModelCatalog } from '../server/model-catalog.mjs';
import { createInviteGroups } from '../server/invite-groups.mjs';

const rule = { sourceRouteKey: 'Opus', sourceVariantName: '', targetRouteKey: 'GPT', targetVariantName: '', enabled: true, effort: 'high', fallbacks: [{ targetRouteKey: 'Opus', targetVariantName: '', effort: 'auto' }] };
const plan = { name: '专业版', description: '', priceCents: 1000, currency: 'USD', interval: 'month', dailyLimit: 77, allowedRoutes: ['Opus'], active: false, allowStripe: false, allowManual: true, sortOrder: 0 };
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-invite-groups-')), store = createStore(directory), app = express();
  let time = Date.parse('2026-01-31T12:34:56.000Z'), seq = 0;
  const stamp = () => new Date(time).toISOString();
  for (const [id, role] of [['admin', 'admin'], ['member', 'user']]) store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES(?,?,?,?,?,?)', id, id, `${id}@example.com`, 'unused-test', role, stamp());
  const billing = createBilling({ store, clock: () => time, stripeFactory: () => { throw new Error('Invitations must not contact Stripe'); } });
  const catalog = createModelCatalog({ store, ensureProviderIdle() {}, ensureRenameIdle() {} });
  const routing = createUserModelRouting({ store, ensureUserIdle() {} });
  const groups = createInviteGroups({ store, userRouting: routing, clock: () => time });
  store.run('INSERT INTO billing_plans(id,data,created_at,updated_at) VALUES(?,?,?,?)', 'plan', JSON.stringify(plan), stamp(), stamp());
  store.run('INSERT INTO providers(id,name,base_url,protocol,encrypted_key,key_hint,created_at) VALUES(?,?,?,?,?,?,?)', 'p', 'source', 'https://api.example.com', 'openai-chat', store.encrypt('key'), 'key', stamp());
  for (const name of ['Opus', 'GPT']) {
    store.run('INSERT INTO model_catalog(name,created_at) VALUES(?,?)', name, stamp());
    store.run('INSERT INTO model_versions(route_key,name,position) VALUES(?,?,?)', name, '', 0);
    store.run('INSERT INTO models(id,provider_id,model_id,name,route_key,reasoning_efforts) VALUES(?,?,?,?,?,?)', name, 'p', name, name, name, '["high"]');
  }
  app.use(express.json());
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const auth = (req, _res, next) => { req.user = store.get('SELECT * FROM users WHERE id=?', req.get('x-user') || ''); next(req.user ? undefined : fail(401, 'auth')); };
  const admin = (req, _res, next) => next(req.user.role === 'admin' ? undefined : fail(403, 'admin'));
  const csrf = (req, _res, next) => next(req.method === 'GET' || req.get('x-csrf-token') === 'test' ? undefined : fail(403, 'csrf'));
  groups.registerRoutes(app, { auth, admin, csrf }); catalog.registerRoutes(app, { auth, admin, csrf });
  app.post('/register-test', (req, res) => {
    const invite = store.get('SELECT * FROM invites WHERE id=?', req.body.inviteId);
    groups.validateInvitation(invite);
    const userId = `joined-${++seq}`;
    store.transaction(() => {
      const current = store.get('SELECT * FROM invites WHERE id=? AND used_at IS NULL AND expires_at>?', invite.id, stamp());
      if (!current) throw fail(409, 'used');
      store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES(?,?,?,?,?,?)', userId, userId, `${userId}@example.com`, 'test', 'user', stamp());
      groups.applyInvitation(current, userId);
      if (req.body.failAfterGrant) throw fail(400, 'force rollback');
      store.run('UPDATE invites SET used_at=? WHERE id=?', stamp(), current.id);
    });
    res.status(201).json({ userId, entitlement: billing.effectiveEntitlement(userId), ...routing.listRules(userId) });
  });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  async function request(path, { user = 'admin', method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}` + path, { method, headers: { 'X-User': user, 'X-CSRF-Token': 'test', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  async function group(body = {}) { const result = await request('/api/admin/invite-groups', { method: 'POST', body: { name: `分组${++seq}`, planId: 'plan', rules: [rule], ...body } }); assert.equal(result.status, 201, JSON.stringify(result)); return result.body.group; }
  function invitation(groupId) {
    const { groupId: selected, groupSnapshot } = groups.snapshotForInvite(groupId, 'admin'), inviteId = `invite-${++seq}`;
    store.run('INSERT INTO invites(id,token_hash,expires_at,created_at,group_id,group_snapshot) VALUES(?,?,?,?,?,?)', inviteId, inviteId, new Date(time + 30 * 86400_000).toISOString(), stamp(), selected, groupSnapshot);
    return store.get('SELECT * FROM invites WHERE id=?', inviteId);
  }
  return { request, store, groups, group, invitation, billing, routing, advance: ms => { time += ms; } };
}

test('invite group management enforces administrator and CSRF with validated configuration', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/admin/invite-groups', { user: '' })).status, 401);
  assert.equal((await f.request('/api/admin/invite-groups', { user: 'member' })).status, 403);
  assert.equal((await f.request('/api/admin/invite-groups', { method: 'POST', body: { name: 'group' }, headers: { 'X-CSRF-Token': '' } })).status, 403);
  for (const body of [{ name: '' }, { name: 'x'.repeat(81) }, { name: 'a', planId: 'missing' }, { name: 'a', enabled: 1 }, { name: 'a', rules: [rule, rule] }, { name: 'a', rules: [{ ...rule, effort: 'max' }] }, { name: 'a', planId: 'plan', duration: 'until', activeUntil: '2020-01-01T00:00:00Z' }]) assert.equal((await f.request('/api/admin/invite-groups', { method: 'POST', body })).status, 400);
  const group = await f.group();
  assert.equal((await f.request('/api/admin/invite-groups', { method: 'POST', body: { name: group.name } })).status, 409);
  assert.equal((await f.request(`/api/admin/invite-groups/${group.id}`, { method: 'PATCH', user: 'member', body: { enabled: false } })).status, 403);
  assert.equal((await f.request(`/api/admin/invite-groups/${group.id}`, { method: 'DELETE', headers: { 'X-CSRF-Token': '' } })).status, 403);
});

test('invitation freezes unpublished plan, routing and backups; monthly grant starts at registration and charges nothing', async t => {
  const f = await fixture(t), group = await f.group(), invite = f.invitation(group.id);
  f.store.run('UPDATE billing_plans SET data=? WHERE id=?', JSON.stringify({ ...plan, dailyLimit: 1 }), 'plan');
  await f.request(`/api/admin/invite-groups/${group.id}`, { method: 'PATCH', body: { name: '新版', planId: 'free', rules: [] } });
  const result = await f.request('/register-test', { method: 'POST', body: { inviteId: invite.id } });
  assert.equal(result.status, 201, JSON.stringify(result));
  assert.equal(result.body.entitlement.dailyLimit, 77); assert.equal(result.body.entitlement.activeUntil, '2026-02-28T12:34:56.000Z');
  assert.equal(result.body.entitlement.source, 'admin'); assert.deepEqual(result.body.rules, [rule]);
  assert.equal(f.store.get('SELECT COUNT(*) AS count FROM billing_checkouts').count, 0);
  assert.equal(f.store.get('SELECT COUNT(*) AS count FROM billing_entitlement_audit').count, 1);
  assert.deepEqual(f.groups.describeInvitation(invite), { groupId: group.id, groupName: group.name });
});

test('disabled/deleted groups revoke outstanding links while already granted users retain their rights', async t => {
  const f = await fixture(t), group = await f.group(), old = f.invitation(group.id), pending = f.invitation(group.id);
  const joined = await f.request('/register-test', { method: 'POST', body: { inviteId: old.id } });
  assert.equal(joined.status, 201);
  assert.equal((await f.request(`/api/admin/invite-groups/${group.id}`, { method: 'PATCH', body: { enabled: false } })).status, 200);
  assert.equal((await f.request('/register-test', { method: 'POST', body: { inviteId: pending.id } })).status, 400);
  assert.throws(() => f.invitation(group.id), /停用/);
  await f.request(`/api/admin/invite-groups/${group.id}`, { method: 'DELETE' });
  assert.equal((await f.request('/register-test', { method: 'POST', body: { inviteId: pending.id } })).status, 400);
  assert.equal(f.billing.effectiveEntitlement(joined.body.userId).dailyLimit, 77);
});

test('registration rights and invite consumption are atomic and a link cannot grant twice', async t => {
  const f = await fixture(t), group = await f.group(), invite = f.invitation(group.id);
  const before = f.store.get('SELECT COUNT(*) AS count FROM users').count;
  assert.equal((await f.request('/register-test', { method: 'POST', body: { inviteId: invite.id, failAfterGrant: true } })).status, 400);
  assert.equal(f.store.get('SELECT COUNT(*) AS count FROM users').count, before);
  assert.equal(f.store.get('SELECT COUNT(*) AS count FROM billing_entitlement_overrides').count, 0);
  assert.equal(f.store.get('SELECT group_user_id FROM invites WHERE id=?', invite.id).group_user_id, null);
  const results = await Promise.all([0, 1].map(() => f.request('/register-test', { method: 'POST', body: { inviteId: invite.id } })));
  assert.deepEqual(results.map(result => result.status).sort(), [201, 400]);
  assert.equal(f.store.get('SELECT COUNT(*) AS count FROM users').count, before + 1);
  assert.equal(f.store.get('SELECT COUNT(*) AS count FROM user_model_routing').count, 1);
});

test('ordinary invitations stay unchanged and free/permanent/until grants use explicit frozen rights', async t => {
  const f = await fixture(t), ordinary = f.invitation(null);
  const simple = await f.request('/register-test', { method: 'POST', body: { inviteId: ordinary.id } });
  assert.equal(simple.status, 201); assert.equal(simple.body.entitlement.source, 'free'); assert.deepEqual(simple.body.rules, []);
  const forever = await f.group({ planId: 'free', duration: 'permanent', rules: [] }), invitation = f.invitation(forever.id);
  f.store.setSetting('dailyLimit', 3);
  const result = await f.request('/register-test', { method: 'POST', body: { inviteId: invitation.id } });
  assert.equal(result.body.entitlement.activeUntil, null); assert.equal(result.body.entitlement.dailyLimit, 100); assert.equal(result.body.entitlement.source, 'admin');
  const until = await f.group({ duration: 'until', activeUntil: '2026-02-02T00:00:00Z', rules: [] }), late = f.invitation(until.id);
  f.advance(3 * 86400_000);
  assert.equal((await f.request('/register-test', { method: 'POST', body: { inviteId: late.id } })).status, 400);
});

test('frozen routing survives transient channel downtime and users cannot choose their grant in registration', async t => {
  const f = await fixture(t), group = await f.group({ planId: null }), invite = f.invitation(group.id);
  f.store.run('UPDATE providers SET enabled=0');
  const result = await f.request('/register-test', { method: 'POST', body: { inviteId: invite.id, planId: 'plan', rules: [], duration: 'permanent' } });
  assert.equal(result.status, 201); assert.equal(result.body.entitlement.source, 'free'); assert.deepEqual(result.body.rules, [rule]);
});

test('a revoked administrator invalidates pending grouped invitations and applying outside transaction is refused', async t => {
  const f = await fixture(t), group = await f.group(), invite = f.invitation(group.id);
  assert.throws(() => f.groups.applyInvitation(invite, 'member'), /transaction/);
  f.store.run('UPDATE users SET disabled=1 WHERE id=?', 'admin');
  assert.equal((await f.request('/register-test', { method: 'POST', body: { inviteId: invite.id } })).status, 400);
});

test('renaming a model updates group rules and pending invitation rights including ordered fallbacks', async t => {
  const f = await fixture(t), group = await f.group(), invite = f.invitation(group.id);
  const renamed = await f.request('/api/admin/model-groups', { method: 'PUT', body: { name: 'Opus新版', originalName: 'Opus', variants: [{ name: '', modelIds: ['Opus'] }] } });
  assert.equal(renamed.status, 200, JSON.stringify(renamed));
  const current = (await f.request('/api/admin/invite-groups')).body.groups[0];
  assert.equal(current.rules[0].sourceRouteKey, 'Opus新版'); assert.equal(current.rules[0].fallbacks[0].targetRouteKey, 'Opus新版');
  const result = await f.request('/register-test', { method: 'POST', body: { inviteId: invite.id } });
  assert.equal(result.status, 201, JSON.stringify(result)); assert.deepEqual(result.body.entitlement.allowedRoutes, ['Opus新版']);
  assert.equal(result.body.entitlement.dailyLimit, 77); assert.equal(result.body.rules[0].fallbacks[0].targetRouteKey, 'Opus新版');
});

test('real app registration applies grouped rights once under simultaneous acceptance and keeps lookup private', async t => {
  const { createApp } = await import('../server/app.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-invite-http-'));
  const application = createApp({ dataDir: directory, setupToken: 'invite-test-setup-code', logger: { error() {} }, stripeFactory: () => { throw new Error('Must not charge'); } });
  const server = createServer(application.app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { application.abortAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); application.close(); rmSync(directory, { recursive: true, force: true }); });
  let admin;
  async function request(path, body, session) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}` + path, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const setup = await request('/api/auth/setup', { setupToken: 'invite-test-setup-code', name: 'admin', email: 'admin@example.com', password: 'invite-test-password-2026' });
  assert.equal(setup.status, 201); admin = { ...setup.body, cookie: setup.cookie };
  const paid = await request('/api/admin/plans', plan, admin); assert.equal(paid.status, 201);
  const created = await request('/api/admin/invite-groups', { name: '受邀专业组', planId: paid.body.plan.id, duration: 'permanent', rules: [] }, admin); assert.equal(created.status, 201);
  const invite = await request('/api/admin/invites', { groupId: created.body.group.id, days: 7 }, admin); assert.equal(invite.status, 201);
  const lookup = await request(`/api/auth/invite?token=${invite.body.invite.token}`);
  assert.equal(lookup.status, 200); assert.equal('rules' in lookup.body, false); assert.equal('groupSnapshot' in lookup.body, false);
  const accepts = await Promise.all(['one', 'two'].map(name => request('/api/auth/invite/accept', { token: invite.body.invite.token, name, email: `${name}@example.com`, password: 'invite-test-password-2026', planId: 'free', duration: 'until' })));
  assert.equal(accepts.filter(result => result.status === 201).length, 1);
  assert.ok(accepts.some(result => [400, 409].includes(result.status)), JSON.stringify(accepts));
  const accepted = accepts.find(result => result.status === 201), session = { ...accepted.body, cookie: accepted.cookie };
  const membership = await request('/api/billing', undefined, session);
  assert.equal(membership.status, 200); assert.equal(membership.body.membership.source, 'admin'); assert.equal(membership.body.membership.dailyLimit, 77); assert.equal(membership.body.membership.activeUntil, null);
  assert.equal(application.store.get('SELECT COUNT(*) AS count FROM billing_entitlement_overrides').count, 1);
  assert.equal(application.store.get('SELECT COUNT(*) AS count FROM users').count, 2);
});
