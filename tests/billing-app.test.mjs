import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';

const setupToken = 'billing-http-private-setup-token';
const password = 'billing-http-test-password-2026';
const mockKey = 'billing-local-upstream-secret';
const frame = data => `data: ${JSON.stringify(data)}\n\n`;

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t) {
  const previousEnvironment = { private: process.env.ALLOW_PRIVATE_UPSTREAM, origin: process.env.PUBLIC_ORIGIN };
  process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  delete process.env.PUBLIC_ORIGIN;
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-billing-http-'));
  const servers = [];
  const captured = [];
  let instance;
  t.after(async () => {
    instance?.abortAll();
    for (const server of servers) server.closeAllConnections();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    instance?.close();
    const resolved = realpathSync(directory);
    const parent = realpathSync(tmpdir());
    assert.ok(resolved.startsWith(parent + sep) && resolved.includes('apirouter-billing-http-'));
    rmSync(resolved, { recursive: true, force: true });
    if (previousEnvironment.private === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM;
    else process.env.ALLOW_PRIVATE_UPSTREAM = previousEnvironment.private;
    if (previousEnvironment.origin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousEnvironment.origin;
  });

  const upstream = createServer(async (req, res) => {
    try {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'basic-wire-model' }, { id: 'premium-wire-model' }] }));
        return;
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      captured.push({ body, url: req.url, authorization: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame({ choices: [{ delta: { content: `模型 ${body.model} 已完成回答。` } }] }));
      res.write(frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 5 } }));
      res.end('data: [DONE]\n\n');
    } catch (error) { res.destroy(error); }
  });
  servers.push(upstream);
  const upstreamBase = await listen(upstream);
  instance = createApp({ dataDir: directory, setupToken, logger: { error() {} }, stripeFactory: () => { throw new Error('This HTTP membership test must not contact Stripe.'); } });
  const server = createServer(instance.app);
  servers.push(server);
  const base = await listen(server);

  async function request(path, { session, method = 'GET', body, csrf = true, headers = {}, raw = false } = {}) {
    const requestHeaders = { ...(session ? { Cookie: session.cookie } : {}), ...(session && csrf && method !== 'GET' ? { 'X-CSRF-Token': session.csrfToken } : {}), ...headers };
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    const response = await fetch(base + path, { method, headers: requestHeaders, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (raw) return response;
    const data = await response.json();
    return { response, data, status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function expect(path, options, status = 200) {
    const result = await request(path, options);
    assert.equal(result.status, status, `${options?.method || 'GET'} ${path}: ${JSON.stringify(result.data)}`);
    return result.data;
  }
  const created = await request('/api/auth/setup', { method: 'POST', body: { setupToken, name: '会员测试管理员', email: 'billing-admin@example.com', password } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const admin = { ...created.data, cookie: created.cookie };
  assert.match(created.response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(created.response.headers.get('set-cookie'), /SameSite=Strict/);

  async function inviteMember(email, name) {
    const invitation = await expect('/api/admin/invites', { method: 'POST', session: admin, body: { email, days: 1 } }, 201);
    const accepted = await request('/api/auth/invite/accept', { method: 'POST', body: { token: invitation.invite.token, email, name, password } });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.data));
    return { ...accepted.data, cookie: accepted.cookie };
  }
  const member = await inviteMember('billing-member@example.com', '普通成员');
  const outsider = await inviteMember('billing-outsider@example.com', '其他成员');
  const { provider } = await expect('/api/admin/providers', { method: 'POST', session: admin, body: { name: '会员权限本地上游', baseUrl: upstreamBase, apiKey: mockKey, protocol: 'openai-chat' } }, 201);
  const synced = await expect(`/api/admin/providers/${provider.id}/sync`, { method: 'POST', session: admin });
  const internalBasic = synced.models.find(model => model.modelId === 'basic-wire-model');
  const internalPremium = synced.models.find(model => model.modelId === 'premium-wire-model');
  assert.ok(internalBasic && internalPremium);
  await expect(`/api/admin/models/${internalBasic.id}`, { method: 'PATCH', session: admin, body: { enabled: true, routeKey: 'basic' } });
  await expect(`/api/admin/models/${internalPremium.id}`, { method: 'PATCH', session: admin, body: { enabled: true, routeKey: 'premium', isDefault: true } });
  const allModels = (await expect('/api/models', { session: admin })).models;
  const basic = allModels.find(model => model.routeKey === 'basic');
  const premium = allModels.find(model => model.routeKey === 'premium');
  assert.ok(basic && premium);

  async function send(chatId, modelId, content, session = member) {
    const response = await request(`/api/chats/${chatId}/messages`, { method: 'POST', session, body: { modelId, content }, raw: true });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.ok(!text.includes(mockKey));
    const events = text.split('\n\n').filter(part => part.startsWith('event:')).map(part => ({ type: part.split('\n')[0].slice(7), data: JSON.parse(part.split('\ndata: ')[1]) }));
    assert.equal(events.at(-1)?.type, 'done', text);
    const message = events.at(-1).data.message;
    assert.equal(message.status, 'complete');
    return message;
  }
  return { request, expect, send, instance, admin, member, outsider, basic, premium, internalBasic, internalPremium, captured };
}

test('HTTP membership enforces free routes, manual approval, paid quota and administrator overrides', async t => {
  const ctx = await fixture(t);
  const { request, expect, send, instance, admin, member, outsider, basic, premium, internalPremium, captured } = ctx;
  let plan, application, chat;

  await t.test('billing routes enforce authentication, administrator role, CSRF and request origin', async () => {
    await expect('/api/billing', {}, 401);
    await expect('/api/admin/billing/settings', {}, 401);
    await expect('/api/admin/plans', { session: member }, 403);
    await expect('/api/admin/billing/requests', { session: member }, 403);
    await expect('/api/admin/billing/settings', { session: member, method: 'PATCH', body: { freeAllowedRoutes: [] } }, 403);
    await expect('/api/admin/billing/settings', { session: admin, method: 'PATCH', csrf: false, body: { freeAllowedRoutes: ['basic'] } }, 403);
    await expect('/api/admin/billing/settings', { session: admin, method: 'PATCH', headers: { Origin: 'https://untrusted.example' }, body: { freeAllowedRoutes: ['basic'] } }, 403);
    await expect('/api/admin/billing/settings', { session: admin, method: 'PATCH', body: { freeAllowedRoutes: ['basic'], stripeEnabled: false } });
    const created = await expect('/api/admin/plans', { session: admin, method: 'POST', body: {
      name: '两次请求会员', description: '本地集成测试套餐', priceCents: 1400, currency: 'USD', interval: 'month',
      dailyLimit: 2, allowedRoutes: ['basic', 'premium'], active: true, allowStripe: false, allowManual: true, sortOrder: 10,
    } }, 201);
    plan = created.plan;
    assert.equal(plan.priceCents, 1400);
    assert.equal(plan.dailyLimit, 2);
    assert.deepEqual(plan.allowedRoutes, ['basic', 'premium']);
    const free = await expect('/api/billing', { session: member });
    assert.equal(free.membership, null);
    assert.deepEqual(free.freePlan.allowedRoutes, ['basic']);
    assert.equal(free.paymentMethods.stripe, false);
    assert.equal(free.paymentMethods.manual, true);
    assert.equal(free.plans.find(item => item.id === plan.id).priceCents, 1400);
  });

  await t.test('free model restrictions apply to public IDs, legacy IDs, model changes and default fallback', async () => {
    const listed = await expect('/api/models', { session: member });
    assert.deepEqual(listed.models.map(model => model.routeKey), ['basic']);
    assert.equal(listed.defaultModelId, basic.id, 'a restricted global default must not be offered to free users');
    assert.deepEqual(new Set((await expect('/api/models', { session: admin })).models.map(model => model.routeKey)), new Set(['basic', 'premium']));
    chat = (await expect('/api/chats', { session: member, method: 'POST', body: { modelId: basic.id } }, 201)).chat;
    for (const modelId of [premium.id, internalPremium.id]) {
      const create = await expect('/api/chats', { session: member, method: 'POST', body: { modelId } }, 403);
      assert.equal(create.code, 'PLAN_MODEL_RESTRICTED');
      await expect(`/api/chats/${chat.id}`, { session: member, method: 'PATCH', body: { modelId } }, 403);
      for (const action of ['messages', 'regenerate', 'edit']) {
        await expect(`/api/chats/${chat.id}/${action}`, { session: member, method: 'POST', body: { modelId, content: '尝试越过免费模型限制', messageId: 'not-a-real-message' } }, 403);
      }
    }
    const blank = (await expect('/api/chats', { session: member, method: 'POST', body: {} }, 201)).chat;
    await expect(`/api/chats/${blank.id}/messages`, { session: member, method: 'POST', body: { content: '省略模型不能借用付费默认模型' } }, 403);
    await expect(`/api/chats/${chat.id}/messages`, { session: member, method: 'POST', csrf: false, body: { modelId: basic.id, content: '未通过 CSRF 的请求' } }, 403);
    const stored = await expect(`/api/chats/${chat.id}`, { session: member });
    assert.equal(stored.chat.modelId, basic.id, 'a rejected model change must preserve the selected model');
    assert.deepEqual(stored.messages, []);
    assert.equal(captured.length, 0, 'denied requests must never reach the upstream');
    assert.equal(instance.store.get('SELECT COUNT(*) AS n FROM requests WHERE user_id=?', member.user.id).n, 0, 'denied requests must not consume quota');
  });

  await t.test('manual applications are isolated and do not grant access before authorized approval', async () => {
    const body = { planId: plan.id, note: '请开通测试会员。' };
    await expect('/api/billing/requests', { method: 'POST', body }, 401);
    await expect('/api/billing/requests', { method: 'POST', session: member, csrf: false, body }, 403);
    await expect('/api/billing/requests', { method: 'POST', session: member, headers: { 'X-CSRF-Token': outsider.csrfToken }, body }, 403);
    await expect('/api/billing/requests', { method: 'POST', session: member, headers: { Origin: 'https://untrusted.example' }, body }, 403);
    application = (await expect('/api/billing/requests', { method: 'POST', session: member, body }, 201)).request;
    assert.equal(application.userId, member.user.id);
    assert.equal(application.planId, plan.id);
    assert.equal(application.status, 'pending');
    assert.equal(application.plan.priceCents, 1400);
    assert.equal(application.plan.dailyLimit, 2);
    await expect('/api/billing/requests', { method: 'POST', session: member, body }, 409);
    const before = await expect('/api/billing', { session: member });
    assert.equal(before.membership, null);
    assert.equal(before.requests.find(item => item.id === application.id).status, 'pending');
    assert.ok(!(await expect('/api/billing', { session: outsider })).requests.some(item => item.id === application.id), 'another member must not see an application');
    assert.equal((await expect('/api/models', { session: member })).models.length, 1);
    const reviewPath = `/api/admin/billing/requests/${application.id}/review`;
    await expect(reviewPath, { method: 'POST', session: member, body: { decision: 'approve' } }, 403);
    await expect(reviewPath, { method: 'POST', session: outsider, body: { decision: 'approve' } }, 403);
    await expect(reviewPath, { method: 'POST', session: admin, csrf: false, body: { decision: 'approve' } }, 403);
    assert.equal((await expect('/api/billing', { session: member })).membership, null);
    assert.equal((await expect('/api/admin/billing/requests', { session: admin })).requests.find(item => item.id === application.id).status, 'pending');
    const approved = await expect(reviewPath, { method: 'POST', session: admin, body: { decision: 'approve', note: '审核通过，已核对申请。' } });
    assert.equal(approved.request.status, 'approved');
    assert.equal(approved.request.reviewNote, '审核通过，已核对申请。');
    await expect(reviewPath, { method: 'POST', session: admin, body: { decision: 'approve' } }, 409);
  });

  await t.test('approved membership grants real premium access with exactly two daily generation requests', async () => {
    const billing = await expect('/api/billing', { session: member });
    assert.equal(billing.membership.planId, plan.id);
    assert.equal(billing.membership.source, 'manual');
    assert.equal(billing.membership.dailyLimit, 2);
    assert.deepEqual(billing.membership.allowedRoutes, ['basic', 'premium']);
    assert.equal(billing.effectiveDailyLimit, 2);
    assert.ok(Date.parse(billing.membership.activeUntil) > Date.now());
    assert.deepEqual(new Set((await expect('/api/models', { session: member })).models.map(model => model.routeKey)), new Set(['basic', 'premium']));
    assert.equal((await expect('/api/billing', { session: outsider })).membership, null);
    await expect(`/api/chats/${chat.id}`, { session: member, method: 'PATCH', body: { modelId: premium.id } });
    const first = await send(chat.id, premium.id, '会员第一次调用付费模型');
    assert.equal(first.content, '模型 premium-wire-model 已完成回答。');
    assert.equal(first.sourceModel, undefined);
    assert.equal(captured.at(-1).body.model, 'premium-wire-model');
    const second = await send(chat.id, basic.id, '会员第二次调用基础模型');
    assert.equal(second.content, '模型 basic-wire-model 已完成回答。');
    assert.equal(captured.length, 2);
    assert.deepEqual(captured.map(item => item.body.model), ['premium-wire-model', 'basic-wire-model']);
    assert.ok(captured.every(item => item.authorization === `Bearer ${mockKey}`));
    assert.ok(captured.every(item => item.url === '/v1/chat/completions'));
    assert.ok(JSON.stringify(captured[1].body.messages).includes('会员第一次调用付费模型'), 'membership calls retain real chat context');
    const beforeDenied = (await expect(`/api/chats/${chat.id}`, { session: member })).messages;
    const firstUserId = beforeDenied.find(message => message.role === 'user').id;
    for (const action of ['messages', 'regenerate', 'edit']) {
      await expect(`/api/chats/${chat.id}/${action}`, { session: member, method: 'POST', body: { modelId: premium.id, content: '不能超过套餐额度', messageId: firstUserId } }, 429);
    }
    assert.deepEqual((await expect(`/api/chats/${chat.id}`, { session: member })).messages, beforeDenied, 'quota rejection must not append, prune or regenerate history');
    assert.equal(captured.length, 2);
    assert.equal(instance.store.get('SELECT COUNT(*) AS n FROM requests WHERE user_id=?', member.user.id).n, 2);
  });

  await t.test('administrator limits override membership explicitly, and null restores the plan limit', async () => {
    const path = `/api/admin/users/${member.user.id}`;
    await expect(path, { session: member, method: 'PATCH', body: { dailyLimit: 100 } }, 403);
    await expect(path, { session: admin, method: 'PATCH', csrf: false, body: { dailyLimit: 100 } }, 403);
    await expect(path, { session: admin, method: 'PATCH', body: { dailyLimit: 0 } });
    assert.equal((await expect('/api/billing', { session: member })).effectiveDailyLimit, 0);
    await expect(`/api/chats/${chat.id}/messages`, { session: member, method: 'POST', body: { modelId: premium.id, content: '零额度应暂停请求' } }, 429);
    await expect(path, { session: admin, method: 'PATCH', body: { dailyLimit: 3 } });
    assert.equal((await expect('/api/billing', { session: member })).effectiveDailyLimit, 3);
    const third = await send(chat.id, premium.id, '管理员增加额度后的第三次请求');
    assert.equal(third.sourceModel, undefined);
    assert.equal(captured.at(-1).body.model, 'premium-wire-model');
    await expect(`/api/chats/${chat.id}/messages`, { session: member, method: 'POST', body: { modelId: premium.id, content: '第三次之后不能继续' } }, 429);
    const restored = await expect(path, { session: admin, method: 'PATCH', body: { dailyLimit: null } });
    assert.equal(restored.user.dailyLimit, null);
    const billing = await expect('/api/billing', { session: member });
    assert.equal(billing.membership.dailyLimit, 2);
    assert.equal(billing.effectiveDailyLimit, 2, 'null restores membership quota rather than the global free quota');
    await expect(`/api/chats/${chat.id}/messages`, { session: member, method: 'POST', body: { modelId: premium.id, content: '恢复套餐不会重置今日已用请求' } }, 429);
    assert.equal(captured.length, 3);
    assert.equal(instance.store.get('SELECT COUNT(*) AS n FROM requests WHERE user_id=?', member.user.id).n, 3);
  });

  await t.test('free route settings fail closed for malformed writes and do not alter paid entitlements', async () => {
    const path = '/api/admin/billing/settings';
    for (const value of ['basic', null, ['basic', { model: 'premium' }]]) {
      await expect(path, { session: admin, method: 'PATCH', body: { freeAllowedRoutes: value } }, 400);
      assert.deepEqual((await expect('/api/billing', { session: outsider })).freePlan.allowedRoutes, ['basic']);
      assert.deepEqual((await expect('/api/models', { session: outsider })).models.map(model => model.routeKey), ['basic']);
    }
    await expect(path, { session: admin, method: 'PATCH', body: { freeAllowedRoutes: ['premium'] } });
    assert.deepEqual((await expect('/api/models', { session: outsider })).models.map(model => model.routeKey), ['premium']);
    await expect('/api/chats', { session: outsider, method: 'POST', body: { modelId: basic.id } }, 403);
    await expect('/api/chats', { session: outsider, method: 'POST', body: { modelId: ctx.internalBasic.id } }, 403);
    const paid = await expect('/api/billing', { session: member });
    assert.deepEqual(paid.membership.allowedRoutes, ['basic', 'premium']);
    assert.deepEqual(new Set((await expect('/api/models', { session: member })).models.map(model => model.routeKey)), new Set(['basic', 'premium']));
    assert.equal(captured.length, 3, 'configuration and rejection checks never call a paid upstream');
  });

  await t.test('rejected manual applications remain free and session revocation closes billing access', async () => {
    const pending = (await expect('/api/billing/requests', { session: outsider, method: 'POST', body: { planId: plan.id, note: '应该被拒绝的申请' } }, 201)).request;
    const reviewed = await expect(`/api/admin/billing/requests/${pending.id}/review`, { session: admin, method: 'POST', body: { decision: 'reject', note: '本次未开通。' } });
    assert.equal(reviewed.request.status, 'rejected');
    const afterRejected = await expect('/api/billing', { session: outsider });
    assert.equal(afterRejected.membership, null);
    assert.equal(afterRejected.requests.find(item => item.id === pending.id).status, 'rejected');
    assert.ok(!afterRejected.requests.some(item => item.id === application.id));
    await expect('/api/auth/logout', { session: member, method: 'POST' });
    await expect('/api/billing', { session: member }, 401);
    await expect('/api/billing/requests', { session: member, method: 'POST', body: { planId: plan.id } }, 401);
    await expect(`/api/admin/users/${outsider.user.id}`, { session: admin, method: 'PATCH', body: { disabled: true } });
    await expect('/api/billing', { session: outsider }, 401);
  });
});
