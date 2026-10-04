import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import Stripe from 'stripe';
import { createStore } from '../server/store.mjs';
import { createBilling, addBillingPeriod } from '../server/billing.mjs';
import { createModelCatalog } from '../server/model-catalog.mjs';

const secretKey = 'sk_test_localBillingOnly123456';
const webhookSecret = 'whsec_localWebhookOnly987654';
const fail = (status, message) => Object.assign(new Error(message), { status });
const planInput = { name: '专业版', description: '测试套餐', priceCents: 1200, currency: 'USD', interval: 'month', dailyLimit: 50, allowedRoutes: ['basic', 'advanced'], active: true, allowStripe: true, allowManual: true, sortOrder: 0 };
const clone = object => JSON.parse(JSON.stringify(object));

async function fixture(t, { publicOrigin = 'https://workspace.example.com' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-billing-test-'));
  const store = createStore(directory), app = express();
  let time = Date.parse('2026-01-31T12:34:56.000Z');
  const sessions = new Map(), subscriptions = new Map(), calls = [], sdk = new Stripe(secretKey);
  let sequence = 0, failNextCreate = false, failNextRetrieve = false;
  let gate;
  async function waitForGate(type) { if (gate?.type === type) { const current = gate; gate = null; current.entered.resolve(); await current.release.promise; } }
  const mock = {
    webhooks: sdk.webhooks,
    checkout: { sessions: {
      async create(params, options) {
        calls.push({ type: 'create', params: clone(params), options });
        await waitForGate('create');
        if (failNextCreate) { failNextCreate = false; throw new Error('secret upstream failure sk_test_DO_NOT_LEAK'); }
        const old = [...sessions.values()].find(session => session.metadata.checkoutId === params.metadata.checkoutId);
        if (old) return clone(old);
        const session = { id: `cs_test_${++sequence}`, url: `https://checkout.stripe.com/c/pay/cs_test_${sequence}`, status: 'open', mode: params.mode, client_reference_id: params.client_reference_id, metadata: params.metadata, expires_at: params.expires_at };
        sessions.set(session.id, session); return clone(session);
      },
      async retrieve(sessionId) { calls.push({ type: 'session', sessionId }); await waitForGate('session'); if (!sessions.has(sessionId)) throw new Error('missing session'); return clone(sessions.get(sessionId)); }
    } },
    subscriptions: { async retrieve(subscriptionId, params) {
      calls.push({ type: 'subscription', subscriptionId, params });
      await waitForGate('subscription');
      if (failNextRetrieve) { failNextRetrieve = false; throw new Error('temporary network error with secret'); }
      if (!subscriptions.has(subscriptionId)) throw new Error('missing subscription'); return clone(subscriptions.get(subscriptionId));
    } },
    billingPortal: { sessions: { async create(params) { calls.push({ type: 'portal', params }); return { url: 'https://billing.stripe.com/p/session_local_test' }; } } }
  };
  for (const [id, role] of [['admin', 'admin'], ['admin2', 'admin'], ['user', 'user'], ['other', 'user']]) store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES(?,?,?,?,?,?)', id, id, `${id}@example.com`, 'test', role, new Date(time).toISOString());
  const billing = createBilling({ store, publicOrigin, clock: () => time, stripeFactory: key => { assert.equal(key, secretKey); return mock; } });
  billing.mountWebhook(app);
  app.use(express.json());
  app.use((req, _res, next) => { req.user = store.get('SELECT * FROM users WHERE id=?', req.get('x-user') || ''); next(); });
  const auth = (req, _res, next) => req.user ? next() : next(fail(401, 'auth'));
  const admin = (req, _res, next) => req.user.role === 'admin' ? next() : next(fail(403, 'admin'));
  const csrf = (req, _res, next) => req.method === 'GET' || req.get('x-csrf-token') === 'test' ? next() : next(fail(403, 'csrf'));
  billing.registerRoutes(app, { auth, admin, csrf });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  async function request(path, { method = 'GET', body, user = 'user', headers = {} } = {}) {
    const result = await fetch(base + path, { method, headers: { 'X-User': user, 'X-CSRF-Token': 'test', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, body: await result.json() };
  }
  async function plan(extra = {}) { const response = await request('/api/admin/plans', { method: 'POST', user: 'admin', body: { ...planInput, ...extra } }); assert.equal(response.status, 201, JSON.stringify(response)); return response.body.plan; }
  async function enable() { const response = await request('/api/admin/billing/settings', { method: 'PATCH', user: 'admin', body: { stripeEnabled: true, secretKey, webhookSecret } }); assert.equal(response.status, 200, JSON.stringify(response)); return response.body; }
  async function apply(planId, user = 'user') { const response = await request('/api/billing/requests', { method: 'POST', user, body: { planId, note: '请开通' } }); assert.equal(response.status, 201, JSON.stringify(response)); return response.body.request; }
  async function review(requestId, decision = 'approve', user = 'admin') { return request(`/api/admin/billing/requests/${requestId}/review`, { method: 'POST', user, body: { decision, note: '已处理' } }); }
  async function checkout(planId, user = 'user') { return request('/api/billing/checkout', { method: 'POST', user, body: { planId, priceCents: 1, userId: 'other' } }); }
  function complete(sessionId = [...sessions.keys()].at(-1), overrides = {}) {
    const session = sessions.get(sessionId), call = calls.find(call => call.type === 'create' && call.params.metadata.checkoutId === session.metadata.checkoutId);
    session.status = 'complete'; session.payment_status = 'paid'; session.customer = `cus_${session.client_reference_id}`; session.subscription = `sub_${session.id}`;
    const data = call.params.line_items[0].price_data;
    const subscription = { id: session.subscription, metadata: session.metadata, customer: session.customer, status: 'active', cancel_at_period_end: false, latest_invoice: { status: 'paid' }, items: { data: [{ quantity: 1, price: { unit_amount: data.unit_amount, currency: data.currency, recurring: data.recurring }, current_period_end: Math.floor((time + 28 * 86400_000) / 1000) }] }, ...overrides };
    subscriptions.set(subscription.id, subscription); return { session, subscription };
  }
  async function webhook(type, object, { eventId = `evt_${++sequence}`, valid = true, liveMode = false } = {}) {
    const payload = JSON.stringify({ id: eventId, type, livemode: liveMode, created: Math.floor(time / 1000), data: { object } });
    const signature = valid ? sdk.webhooks.generateTestHeaderString({ payload, secret: webhookSecret }) : 't=1,v1=wrong';
    const result = await fetch(base + '/api/billing/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, body: payload });
    return { status: result.status, body: await result.json(), eventId };
  }
  function pauseCall(type) { gate = { type, entered: Promise.withResolvers(), release: Promise.withResolvers() }; const current = gate; t.after(() => current.release.resolve()); return { entered: current.entered.promise, release: () => current.release.resolve() }; }
  return { store, billing, request, plan, enable, apply, review, checkout, complete, webhook, sessions, subscriptions, calls, pauseCall, setTime: value => { time = new Date(value).getTime(); }, failCreate: () => { failNextCreate = true; }, failRetrieve: () => { failNextRetrieve = true; } };
}

test('model rename waits for checkout, subscription webhook and manual application network snapshots', async t => {
  const f = await fixture(t); await f.enable(); const plan = await f.plan();
  const catalog = createModelCatalog({ store: f.store, ensureProviderIdle() {}, ensureRenameIdle: f.billing.ensureModelRenameIdle });
  catalog.saveGroup({ name: 'basic', variants: [] });
  const rename = () => catalog.saveGroup({ originalName: 'basic', name: 'new-basic', variants: [] });
  function blocked() { assert.throws(rename, error => error.status === 409 && /支付操作/.test(error.message)); assert.deepEqual(JSON.parse(f.store.get('SELECT data FROM billing_plans WHERE id=?', plan.id).data).allowedRoutes, plan.allowedRoutes); }
  const checkoutGate = f.pauseCall('create'), checkout = f.checkout(plan.id);
  await checkoutGate.entered; try { blocked(); } finally { checkoutGate.release(); }
  assert.equal((await checkout).status, 200);
  const { session } = f.complete(), webhookGate = f.pauseCall('subscription');
  const webhook = f.webhook('checkout.session.completed', session);
  await webhookGate.entered; try { blocked(); } finally { webhookGate.release(); }
  assert.equal((await webhook).status, 200);
  assert.equal((await f.checkout(plan.id, 'other')).status, 200);
  const otherSession = [...f.sessions.values()].find(row => row.client_reference_id === 'other'); otherSession.status = 'expired';
  f.setTime('2026-01-31T14:34:56.000Z');
  const manualGate = f.pauseCall('session'), application = f.apply(plan.id, 'other');
  await manualGate.entered; try { blocked(); } finally { manualGate.release(); }
  await application;
  rename();
  assert.deepEqual(JSON.parse(f.store.get('SELECT plan_snapshot FROM billing_memberships WHERE user_id=?', 'user').plan_snapshot).allowedRoutes, ['new-basic', 'advanced']);
  assert.deepEqual(JSON.parse(f.store.get('SELECT plan_snapshot FROM billing_requests WHERE user_id=?', 'other').plan_snapshot).allowedRoutes, ['new-basic', 'advanced']);
});

test('calendar subscriptions clamp month ends and leap days in UTC', () => {
  assert.equal(addBillingPeriod('2026-01-31T12:34:56.000Z', 'month'), '2026-02-28T12:34:56.000Z');
  assert.equal(addBillingPeriod('2024-01-31T12:34:56.000Z', 'month'), '2024-02-29T12:34:56.000Z');
  assert.equal(addBillingPeriod('2024-02-29T12:34:56.000Z', 'year'), '2025-02-28T12:34:56.000Z');
});

test('billing permissions, validation, free routes, and explicit account quota override', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/billing', { user: '' })).status, 401);
  assert.equal((await f.request('/api/admin/plans')).status, 403);
  assert.equal((await f.request('/api/admin/plans', { method: 'POST', user: 'admin', body: planInput, headers: { 'X-CSRF-Token': '' } })).status, 403);
  for (const value of [-1, 0, 1.2, 100_000_000]) assert.equal((await f.request('/api/admin/plans', { method: 'POST', user: 'admin', body: { ...planInput, priceCents: value } })).status, 400);
  assert.equal((await f.request('/api/admin/billing/settings', { method: 'PATCH', user: 'admin', body: { freeAllowedRoutes: ['basic', 'basic'] } })).status, 200);
  assert.deepEqual(f.billing.effectiveEntitlement('user').allowedRoutes, ['basic']);
  f.store.run('UPDATE users SET daily_limit=7 WHERE id=?', 'user');
  assert.equal((await f.request('/api/billing')).body.effectiveDailyLimit, 7);
  const p = await f.plan(); const r = await f.apply(p.id); await f.review(r.id);
  assert.equal(f.billing.effectiveEntitlement('user').dailyLimit, 7);
  assert.deepEqual(f.billing.effectiveEntitlement('user').allowedRoutes, ['basic', 'advanced']);
});

test('manual requests snapshot purchase terms, reject duplicates, renew, and expire', async t => {
  const f = await fixture(t), p = await f.plan();
  const r = await f.apply(p.id);
  assert.equal((await f.request('/api/billing/requests', { method: 'POST', body: { planId: p.id } })).status, 409);
  assert.equal((await f.request('/api/billing', { user: 'other' })).body.requests.length, 0);
  await f.request(`/api/admin/plans/${p.id}`, { method: 'PATCH', user: 'admin', body: { dailyLimit: 500, priceCents: 9999 } });
  assert.equal((await f.review(r.id)).status, 200);
  assert.equal((await f.review(r.id)).status, 409);
  let member = (await f.request('/api/billing')).body.membership;
  assert.equal(member.dailyLimit, 50); assert.equal(member.activeUntil, '2026-02-28T12:34:56.000Z');
  assert.equal(f.billing.effectiveEntitlement('user').dailyLimit, 50);
  const rejected = await f.apply(p.id); assert.equal((await f.review(rejected.id, 'reject')).status, 200);
  assert.equal((await f.request('/api/billing')).body.membership.activeUntil, member.activeUntil);
  const renewal = await f.apply(p.id); assert.equal((await f.review(renewal.id)).status, 200);
  member = (await f.request('/api/billing')).body.membership;
  assert.equal(member.activeUntil, '2026-03-28T12:34:56.000Z'); assert.equal(member.dailyLimit, 500);
  f.setTime('2026-03-29');
  assert.equal((await f.request('/api/billing')).body.membership, null);
  assert.equal(f.billing.effectiveEntitlement('user').planId, 'free');
});

test('approval forbids self review and disabled users and is atomic under repeated requests', async t => {
  const f = await fixture(t), p = await f.plan();
  assert.equal((await f.request('/api/billing', { user: 'admin' })).body.canRequestManual, true);
  const own = await f.apply(p.id, 'admin');
  assert.equal((await f.review(own.id)).status, 403);
  assert.equal((await f.review(own.id, 'approve', 'admin2')).status, 200);
  const r = await f.apply(p.id);
  f.store.run('UPDATE users SET disabled=1 WHERE id=?', 'user'); assert.equal((await f.review(r.id)).status, 400);
  f.store.run('UPDATE users SET disabled=0 WHERE id=?', 'user');
  const results = await Promise.all([f.review(r.id), f.review(r.id)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(f.billing.effectiveEntitlement('user').activeUntil, '2026-02-28T12:34:56.000Z');
});

test('the only active administrator cannot create an unreviewable manual request', async t => {
  const f = await fixture(t), p = await f.plan();
  f.store.run('UPDATE users SET disabled=1 WHERE id=?', 'admin2');
  assert.equal((await f.request('/api/billing', { user: 'admin' })).body.canRequestManual, false);
  assert.equal((await f.request('/api/billing')).body.canRequestManual, true);
  const denied = await f.request('/api/billing/requests', { method: 'POST', user: 'admin', body: { planId: p.id } });
  assert.equal(denied.status, 409);
  assert.match(denied.body.error, /唯一管理员.*其他管理员审批/);
  assert.equal(f.store.get("SELECT COUNT(*) AS count FROM billing_requests WHERE user_id='admin'").count, 0);
  f.store.run('UPDATE users SET disabled=0 WHERE id=?', 'admin2');
  assert.equal((await f.request('/api/billing', { user: 'admin' })).body.canRequestManual, true);
  const own = await f.apply(p.id, 'admin');
  assert.equal((await f.review(own.id)).status, 403);
  assert.equal((await f.review(own.id, 'approve', 'admin2')).status, 200);
});

test('Stripe settings encrypt credentials, retain blank values, and remain separate from public settings', async t => {
  const f = await fixture(t);
  const response = await f.enable();
  assert.equal(response.secretKeyHint, '3456'); assert.equal(response.webhookSecretHint, '7654');
  assert.ok(!JSON.stringify(response).includes(secretKey)); assert.ok(!JSON.stringify(f.store.settings()).includes('Stripe'));
  const config = f.store.get('SELECT * FROM billing_config');
  assert.notEqual(config.encrypted_secret, secretKey); assert.equal(f.store.decrypt(config.encrypted_secret), secretKey);
  const preserved = await f.request('/api/admin/billing/settings', { method: 'PATCH', user: 'admin', body: { secretKey: '', webhookSecret: '' } });
  assert.equal(preserved.body.hasSecretKey, true); assert.equal(preserved.body.webhookUrl, 'https://workspace.example.com/api/billing/webhook');
  const p = await f.plan(); await f.checkout(p.id);
  assert.equal((await f.request('/api/admin/billing/settings', { method: 'PATCH', user: 'admin', body: { secretKey: 'sk_live_exampleRealModeKey' } })).status, 409);
});

test('Checkout uses server pricing and immutable binding; no rights before signed webhook', async t => {
  const f = await fixture(t), p = await f.plan();
  assert.equal((await f.checkout(p.id)).status, 503); await f.enable();
  const created = await f.checkout(p.id); assert.equal(created.status, 200);
  const call = f.calls.find(call => call.type === 'create');
  assert.equal(call.params.line_items[0].price_data.unit_amount, p.priceCents);
  assert.equal(call.params.client_reference_id, 'user'); assert.equal(call.params.subscription_data.metadata.userId, 'user');
  assert.equal(call.params.success_url, 'https://workspace.example.com/?billing=success');
  assert.equal((await f.request('/api/billing?billing=success')).body.membership, null);
  assert.equal((await f.checkout(p.id)).body.url, created.body.url);
  assert.equal(f.calls.filter(call => call.type === 'create').length, 1);
  const { session } = f.complete();
  assert.equal((await f.webhook('checkout.session.completed', session, { valid: false })).status, 400);
  assert.equal((await f.webhook('checkout.session.completed', session, { liveMode: true })).status, 400);
  assert.equal(f.billing.effectiveEntitlement('user').planId, 'free');
  const accepted = await f.webhook('checkout.session.completed', session); assert.equal(accepted.status, 200, JSON.stringify(accepted));
  assert.equal(f.billing.effectiveEntitlement('user').planId, p.id);
  assert.equal(f.billing.effectiveEntitlement('other').planId, 'free');
  const readCount = f.calls.length;
  assert.equal((await f.webhook('checkout.session.completed', session, { eventId: accepted.eventId })).status, 200);
  assert.equal(f.calls.length, readCount);
  assert.equal((await f.checkout(p.id)).status, 409);
  assert.equal((await f.request('/api/billing/requests', { method: 'POST', body: { planId: p.id } })).status, 409);
  const portal = await f.request('/api/billing/portal', { method: 'POST', body: { customerId: 'cus_other' } });
  assert.equal(portal.status, 200); assert.equal(f.calls.at(-1).params.customer, 'cus_user');
  assert.equal((await f.request('/api/billing/portal', { method: 'POST', user: 'other', body: {} })).status, 400);
});

test('ambiguous Checkout failure retries the same durable idempotency key without leaking errors', async t => {
  const f = await fixture(t), p = await f.plan(); await f.enable(); f.failCreate();
  const failed = await f.checkout(p.id); assert.equal(failed.status, 502); assert.ok(!failed.body.error.includes('sk_test'));
  assert.equal((await f.checkout(p.id)).status, 200);
  const creates = f.calls.filter(call => call.type === 'create'); assert.equal(creates.length, 2);
  assert.equal(creates[0].options.idempotencyKey, creates[1].options.idempotencyKey);
  assert.deepEqual(creates[0].params, creates[1].params);
});

test('signed metadata tampering or mismatched purchased price cannot grant membership', async t => {
  const f = await fixture(t), p = await f.plan(); await f.enable(); await f.checkout(p.id);
  const { session, subscription } = f.complete();
  subscription.metadata = { ...subscription.metadata, userId: 'other' };
  assert.equal((await f.webhook('checkout.session.completed', session)).status, 400);
  assert.equal(f.billing.effectiveEntitlement('user').planId, 'free');
  subscription.metadata.userId = 'user'; subscription.items.data[0].price.unit_amount = 1;
  assert.equal((await f.webhook('checkout.session.completed', session)).status, 200);
  assert.equal(f.billing.effectiveEntitlement('user').planId, 'free');
});

test('current subscription state wins over out-of-order events and cancellation retains paid end', async t => {
  const f = await fixture(t), p = await f.plan(); await f.enable(); await f.checkout(p.id);
  const { session, subscription } = f.complete();
  assert.equal((await f.webhook('customer.subscription.created', subscription)).status, 200);
  const initialEnd = f.billing.effectiveEntitlement('user').activeUntil;
  subscription.cancel_at_period_end = true;
  assert.equal((await f.webhook('customer.subscription.updated', { id: subscription.id, status: 'canceled' })).status, 200);
  assert.equal((await f.request('/api/billing')).body.membership.status, 'active');
  assert.equal((await f.request('/api/billing')).body.membership.cancelAtPeriodEnd, true);
  subscription.items.data[0].current_period_end += 28 * 86400;
  subscription.latest_invoice.status = 'open'; subscription.status = 'past_due';
  assert.equal((await f.webhook('invoice.payment_failed', { parent: { subscription_details: { subscription: subscription.id } } })).status, 200);
  assert.equal(f.billing.effectiveEntitlement('user').activeUntil, initialEnd);
  subscription.status = 'canceled';
  assert.equal((await f.webhook('customer.subscription.deleted', subscription)).status, 200);
  assert.equal(f.billing.effectiveEntitlement('user').activeUntil, initialEnd);
  f.setTime('2026-03-01'); assert.equal(f.billing.effectiveEntitlement('user').planId, 'free');
  const r = await f.apply(p.id); await f.review(r.id);
  assert.equal((await f.webhook('checkout.session.completed', session)).status, 200);
  assert.equal(f.billing.effectiveEntitlement('user').source, 'manual');
});

test('failed webhooks are retriable and disabling new payments still processes renewals', async t => {
  const f = await fixture(t), p = await f.plan(); await f.enable(); await f.checkout(p.id);
  const { session, subscription } = f.complete(); f.failRetrieve();
  const failed = await f.webhook('checkout.session.completed', session); assert.equal(failed.status, 502);
  assert.equal(f.store.get('SELECT id FROM billing_events WHERE id=?', failed.eventId), undefined);
  assert.equal((await f.webhook('checkout.session.completed', session, { eventId: failed.eventId })).status, 200);
  await f.request('/api/admin/billing/settings', { method: 'PATCH', user: 'admin', body: { stripeEnabled: false } });
  subscription.items.data[0].current_period_end += 28 * 86400;
  assert.equal((await f.webhook('invoice.paid', { subscription: subscription.id })).status, 200);
  assert.equal(f.billing.effectiveEntitlement('user').activeUntil, '2026-03-28T12:34:56.000Z');
  assert.equal((await f.request('/api/billing')).body.paymentMethods.stripe, false);
  assert.equal((await f.request('/api/billing/portal', { method: 'POST', body: {} })).status, 200);
});

test('expired unpaid Checkout is verified with Stripe before a manual application is allowed', async t => {
  const f = await fixture(t), p = await f.plan(); await f.enable(); await f.checkout(p.id);
  assert.equal((await f.request('/api/billing/requests', { method: 'POST', body: { planId: p.id } })).status, 409);
  f.setTime('2026-01-31T13:20:00Z');
  assert.equal((await f.request('/api/billing/requests', { method: 'POST', body: { planId: p.id } })).status, 409);
  [...f.sessions.values()][0].status = 'expired';
  assert.equal((await f.request('/api/billing/requests', { method: 'POST', body: { planId: p.id } })).status, 201);
});

test('Checkout rejects unsafe deployment origins', async t => {
  const f = await fixture(t, { publicOrigin: 'http://remote.example.com' }), p = await f.plan(); await f.enable();
  assert.equal((await f.checkout(p.id)).status, 400); assert.equal(f.calls.length, 0);
});
