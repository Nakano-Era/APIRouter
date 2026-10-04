import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRouter } from '../server/router.mjs';
import { UpstreamError } from '../server/upstream.mjs';

function fixture(t, channels = [{ id: 'a', priority: 10 }, { id: 'b', priority: 0 }]) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE providers (id TEXT PRIMARY KEY,name TEXT,base_url TEXT,protocol TEXT,encrypted_key TEXT,
    enabled INTEGER,priority INTEGER,failure_threshold INTEGER,cooldown_seconds INTEGER,auth_mode TEXT,runtime TEXT DEFAULT 'api');
    CREATE TABLE models (id TEXT PRIMARY KEY,provider_id TEXT,model_id TEXT,route_key TEXT,enabled INTEGER,
    available INTEGER,vision INTEGER,failure_count INTEGER,cooldown_until TEXT,failure_epoch INTEGER,
    status TEXT,error TEXT,last_checked_at TEXT,reasoning_efforts TEXT DEFAULT '[]');
    CREATE TABLE route_attempts (id TEXT PRIMARY KEY,request_id TEXT,provider_id TEXT,model_id TEXT,outcome TEXT,error TEXT,created_at TEXT,encrypted_detail TEXT,execution_route_key TEXT,execution_variant_name TEXT,execution_effort TEXT);`);
  const store = {
    all: (sql, ...args) => db.prepare(sql).all(...args),
    get: (sql, ...args) => db.prepare(sql).get(...args),
    run: (sql, ...args) => db.prepare(sql).run(...args),
    decrypt: value => value,
    encrypt: value => `encrypted:${value}`,
  };
  for (const c of channels) {
    store.run('INSERT INTO providers VALUES (?,?,?,?,?,?,?,?,?,?,?)', c.id, `Provider ${c.id}`, `https://${c.id}.example.com/v1`, c.protocol ?? 'openai-chat', `secret-${c.id}`, c.providerEnabled ?? 1, c.priority ?? 0, c.threshold ?? 3, c.cooldownSeconds ?? 60, c.authMode ?? 'auto', c.runtime || 'api');
    store.run('INSERT INTO models VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', c.id, c.id, c.upstreamModelId ?? `upstream-${c.id}`, c.routeKey ?? 'shared-model', c.enabled ?? 1, c.available ?? 1, c.vision ?? 0, c.failureCount ?? 0, c.cooldownUntil ?? null, 0, 'untested', null, null, JSON.stringify(c.efforts || []));
  }
  db.exec("ALTER TABLE providers ADD COLUMN responses_profile TEXT DEFAULT 'auto'");
  db.exec('ALTER TABLE models ADD COLUMN retries_override INTEGER');
  db.exec('ALTER TABLE providers ADD COLUMN failure_protection_enabled INTEGER DEFAULT 1; ALTER TABLE models ADD COLUMN variant_name TEXT DEFAULT \'\'; ALTER TABLE models ADD COLUMN failure_protection_enabled INTEGER; ALTER TABLE models ADD COLUMN failure_threshold_override INTEGER; ALTER TABLE models ADD COLUMN cooldown_seconds_override INTEGER;');
  for (const c of channels) {
    store.run('UPDATE providers SET failure_protection_enabled=? WHERE id=?', c.protection ?? 1, c.id);
    store.run('UPDATE models SET variant_name=?,failure_protection_enabled=?,failure_threshold_override=?,cooldown_seconds_override=? WHERE id=?', c.variantName ?? '', c.modelProtection ?? null, c.modelThreshold ?? null, c.modelCooldownSeconds ?? null, c.id);
  }
  return store;
}
const input = overrides => ({ routeKey: 'shared-model', messages: [{ role: 'user', content: 'Hello', attachments: [] }], maxOutputTokens: 200, systemPrompt: 'Be helpful', ...overrides });
const failure = (status = 503) => new UpstreamError(`上游请求失败（HTTP ${status}）。`, 'UPSTREAM_HTTP_ERROR', 502, status);
async function collect(iterator, output = []) { for await (const item of iterator) output.push(item); return output; }
const selected = output => output.filter(item => item.type === 'selected').map(item => item.modelId);
const model = (store, id) => store.get('SELECT * FROM models WHERE id=?', id);
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('reasoning already shown is forwarded without splicing a second channel after failure', async t => {
  const store = fixture(t), output = [];
  const router = createRouter({ store, stream: async function* () { yield { type: 'reasoning', text: 'work in progress' }; throw failure(503); } });
  await assert.rejects(() => collect(router.run(input({})), output));
  assert.deepEqual(selected(output), ['a']);
  assert.equal(output.find(event => event.type === 'reasoning').text, 'work in progress');
});

test('routes only enabled equivalent models in priority order, preserving protocol and upstream identity', async t => {
  const store = fixture(t, [
    { id: 'disabled', priority: 100, enabled: 0 },
    { id: 'unavailable', priority: 100, available: 0 },
    { id: 'provider-off', priority: 100, providerEnabled: 0 },
    { id: 'different', priority: 100, routeKey: 'different-model' },
    { id: 'a', priority: 20, protocol: 'anthropic', authMode: 'bearer', upstreamModelId: 'claude-version' },
    { id: 'b', priority: 10, protocol: 'openai-responses', upstreamModelId: 'mapped-model' },
    { id: 'c', priority: 0 },
  ]);
  const calls = [];
  const router = createRouter({ store, stream: async function* (args) {
    calls.push(args);
    if (args.provider.id === 'a') throw failure(401);
    yield { type: 'delta', text: 'Ready' };
    yield { type: 'usage', inputTokens: 5, outputTokens: 2 };
  } });
  const output = await collect(router.run(input({ requestId: 'request-1' })));
  assert.deepEqual(selected(output), ['a', 'b']);
  assert.equal(calls[0].provider.protocol, 'anthropic');
  assert.equal(calls[0].provider.authMode, 'bearer');
  assert.equal(calls[0].model.modelId, 'claude-version');
  assert.equal(calls[1].provider.protocol, 'openai-responses');
  assert.equal(calls[1].model.modelId, 'mapped-model');
  assert.deepEqual(calls[1].messages, input().messages);
  assert.equal(calls[1].systemPrompt, 'Be helpful');
  assert.equal(calls[1].maxOutputTokens, 200);
  assert.deepEqual(store.all('SELECT model_id,outcome FROM route_attempts ORDER BY rowid').map(row => ({ ...row })), [{ model_id: 'a', outcome: 'error' }, { model_id: 'b', outcome: 'complete' }]);
  assert.equal(model(store, 'a').failure_count, 1);
  assert.equal(model(store, 'b').status, 'ok');
  assert.ok(!JSON.stringify(output).includes('secret-'));
});

test('equal priority uses stable model ID ordering', async t => {
  const store = fixture(t, [{ id: 'b' }, { id: 'a' }]);
  const router = createRouter({ store, stream: async function* () { yield { type: 'delta', text: 'OK' }; } });
  assert.deepEqual(selected(await collect(router.run(input()))), ['a']);
});

test('each upstream model overrides retry defaults, respects zero and total attempt budget', async t => {
  const store = fixture(t, [{ id: 'a', priority: 20, protection: 0 }, { id: 'b', priority: 10, protection: 0 }, { id: 'c', protection: 0 }]);
  store.run('UPDATE models SET retries_override=0 WHERE id=?', 'a');
  store.run('UPDATE models SET retries_override=2 WHERE id=?', 'b');
  const router = createRouter({ store, stream: async function* ({ provider }) { if (provider.id !== 'c') throw failure(); yield { type: 'delta', text: 'success' }; } });
  assert.deepEqual(selected(await collect(router.run(input({ retriesPerChannel: 1, maxAttempts: 8 })))), ['a', 'b', 'b', 'b', 'c']);
  const events = [];
  await assert.rejects(collect(router.run(input({ retriesPerChannel: 1, maxAttempts: 2 })), events));
  assert.deepEqual(selected(events), ['a', 'b']);
});

test('transient failures retry same channel then reset its consecutive failure counter', async t => {
  const store = fixture(t);
  let attempts = 0;
  const callbacks = [];
  const router = createRouter({ store, stream: async function* () {
    if (++attempts === 1) throw failure();
    yield { type: 'delta', text: 'OK' };
  } });
  const result = await collect(router.run(input({ onAttempt: event => callbacks.push(event.attempt) })));
  assert.deepEqual(selected(result), ['a', 'a']);
  assert.deepEqual(callbacks, [1, 2]);
  assert.equal(model(store, 'a').failure_count, 0);
  assert.equal(model(store, 'a').cooldown_until, null);
});

test('threshold counts actual failures and opens a persistent per-model cooldown', async t => {
  const store = fixture(t, [{ id: 'a', priority: 10, threshold: 2 }, { id: 'b' }]);
  const now = Date.parse('2026-09-29T00:00:00Z');
  const calls = [];
  const stream = async function* ({ model: candidate }) {
    calls.push(candidate.id);
    if (candidate.id === 'a') throw failure();
    yield { type: 'delta', text: 'backup' };
  };
  await collect(createRouter({ store, stream, clock: () => now }).run(input({ retriesPerChannel: 3 })));
  assert.deepEqual(calls, ['a', 'a', 'b']);
  assert.equal(model(store, 'a').failure_count, 2);
  assert.equal(model(store, 'a').cooldown_until, '2026-09-29T00:01:00.000Z');
  assert.equal(model(store, 'b').failure_count, 0);
  calls.length = 0;
  await collect(createRouter({ store, stream, clock: () => now }).run(input()));
  assert.deepEqual(calls, ['b']);
});

test('one broken model does not cool down other models on the same provider', async t => {
  const store = fixture(t, [{ id: 'a', threshold: 1 }]);
  store.run("INSERT INTO models(id,provider_id,model_id,route_key,enabled,available,vision,failure_count,cooldown_until,failure_epoch,status,error,last_checked_at,reasoning_efforts) SELECT 'other',provider_id,'other-upstream','other-route',1,1,0,0,NULL,0,'untested',NULL,NULL,'[]' FROM models WHERE id='a'");
  const router = createRouter({ store, stream: async function* ({ model: candidate }) {
    if (candidate.id === 'a') throw failure(404);
    yield { type: 'delta', text: 'Other model works' };
  } });
  await assert.rejects(collect(router.run(input())), { code: 'ROUTE_EXHAUSTED' });
  assert.ok(model(store, 'a').cooldown_until);
  assert.deepEqual(selected(await collect(router.run(input({ routeKey: 'other-route' })))), ['other']);
  assert.equal(model(store, 'other').failure_count, 0);
});

test('cooldown expiry allows a single successful probe and restores priority', async t => {
  const now = Date.parse('2026-09-29T00:02:00Z');
  const store = fixture(t, [{ id: 'a', priority: 10, failureCount: 3, cooldownUntil: '2026-09-29T00:01:00Z' }, { id: 'b' }]);
  const router = createRouter({ store, clock: () => now, stream: async function* () { yield { type: 'delta', text: 'recovered' }; } });
  assert.deepEqual(selected(await collect(router.run(input()))), ['a']);
  assert.equal(model(store, 'a').failure_count, 0);
  assert.equal(model(store, 'a').cooldown_until, null);
  assert.equal(model(store, 'a').status, 'ok');
});

test('failed half-open probe reopens immediately without spending same-channel retries', async t => {
  const now = Date.parse('2026-09-29T00:02:00Z');
  const store = fixture(t, [{ id: 'a', priority: 10, failureCount: 3, cooldownUntil: '2026-09-29T00:01:00Z' }, { id: 'b' }]);
  const router = createRouter({ store, clock: () => now, stream: async function* ({ model: candidate }) {
    if (candidate.id === 'a') throw failure();
    yield { type: 'delta', text: 'backup' };
  } });
  assert.deepEqual(selected(await collect(router.run(input({ retriesPerChannel: 3 })))), ['a', 'b']);
  assert.equal(model(store, 'a').cooldown_until, '2026-09-29T00:03:00.000Z');
});

test('failed recovery probe reopens after an administrator increases the failure threshold', async t => {
  const now = Date.parse('2026-09-29T00:02:00Z');
  const store = fixture(t, [{ id: 'a', threshold: 10, failureCount: 3, cooldownUntil: '2026-09-29T00:01:00Z' }]);
  const router = createRouter({ store, clock: () => now, stream: async function* () { throw failure(); } });
  await assert.rejects(collect(router.run(input())), { code: 'ROUTE_EXHAUSTED' });
  assert.equal(model(store, 'a').cooldown_until, '2026-09-29T00:03:00.000Z');
});

test('only one concurrent half-open probe runs; other requests use a backup without penalty', async t => {
  const now = Date.parse('2026-09-29T00:02:00Z');
  const store = fixture(t, [{ id: 'a', priority: 10, failureCount: 3, cooldownUntil: '2026-09-29T00:01:00Z' }, { id: 'b' }]);
  const started = deferred(), release = deferred();
  let probes = 0;
  const router = createRouter({ store, clock: () => now, stream: async function* ({ model: candidate }) {
    if (candidate.id === 'a') { probes++; started.resolve(); await release.promise; }
    yield { type: 'delta', text: 'OK' };
  } });
  const first = collect(router.run(input()));
  await started.promise;
  const second = await collect(router.run(input()));
  assert.deepEqual(selected(second), ['b']);
  assert.equal(model(store, 'a').failure_count, 3);
  release.resolve();
  assert.deepEqual(selected(await first), ['a']);
  assert.equal(probes, 1);
});

test('attempt budget limits spending across all retries and providers', async t => {
  const store = fixture(t);
  let count = 0;
  const router = createRouter({ store, stream: async function* () { count++; throw failure(); } });
  const result = [];
  await assert.rejects(collect(router.run(input({ maxAttempts: 1, retriesPerChannel: 3 })), result), { code: 'ROUTE_EXHAUSTED' });
  assert.equal(count, 1);
  assert.deepEqual(selected(result), ['a']);
});

test('attempt budget is hard-clamped to one hundred upstream requests', async t => {
  const store = fixture(t, Array.from({ length: 105 }, (_, i) => ({ id: String(i).padStart(2, '0') })));
  let count = 0;
  const router = createRouter({ store, stream: async function* () { count++; throw failure(429); } });
  await assert.rejects(collect(router.run(input({ maxAttempts: 999 }))), { code: 'ROUTE_EXHAUSTED' });
  assert.equal(count, 100);
});

for (const code of ['UPSTREAM_CONNECTION_ERROR', 'UPSTREAM_TIMEOUT']) {
  test(`${code} is retried once before switching channels`, async t => {
    const store = fixture(t);
    const router = createRouter({ store, stream: async function* ({ model: candidate }) {
      if (candidate.id === 'a') throw new UpstreamError('暂时不可用', code, 502);
      yield { type: 'delta', text: 'OK' };
    } });
    assert.deepEqual(selected(await collect(router.run(input()))), ['a', 'a', 'b']);
    assert.equal(model(store, 'a').failure_count, 2);
  });
}

for (const status of [401, 403, 404, 429]) {
  test(`HTTP ${status} switches providers without retrying the same one`, async t => {
    const store = fixture(t);
    const router = createRouter({ store, stream: async function* ({ model: candidate }) {
      if (candidate.id === 'a') throw failure(status);
      yield { type: 'delta', text: 'OK' };
    } });
    assert.deepEqual(selected(await collect(router.run(input({ retriesPerChannel: 3 })))), ['a', 'b']);
    assert.equal(model(store, 'a').failure_count, 1);
  });
}

for (const status of [400, 413, 422]) {
  test(`HTTP ${status} stops without failover or damaging channel health`, async t => {
    const store = fixture(t);
    const router = createRouter({ store, stream: async function* () { throw failure(status); } });
    const result = [];
    await assert.rejects(collect(router.run(input()), result), error => error.upstreamStatus === status);
    assert.deepEqual(selected(result), ['a']);
    assert.equal(model(store, 'a').failure_count, 0);
  });
}

test('local security/configuration errors never retry or poison channel health', async t => {
  const store = fixture(t);
  const router = createRouter({ store, stream: async function* () { throw new UpstreamError('地址受限', 'BLOCKED_UPSTREAM_ADDRESS', 400); } });
  const result = [];
  await assert.rejects(collect(router.run(input()), result), { code: 'BLOCKED_UPSTREAM_ADDRESS' });
  assert.deepEqual(selected(result), ['a']);
  assert.equal(model(store, 'a').failure_count, 0);
});

test('partial reply never switches providers or appends a second answer', async t => {
  const store = fixture(t);
  const router = createRouter({ store, stream: async function* () { yield { type: 'delta', text: 'Partial' }; throw failure(); } });
  const result = [];
  await assert.rejects(collect(router.run(input()), result), { code: 'UPSTREAM_HTTP_ERROR' });
  assert.deepEqual(selected(result), ['a']);
  assert.equal(result.filter(item => item.type === 'delta').length, 1);
  assert.equal(model(store, 'a').failure_count, 1);
});

test('caller cancellation is audited but never counted as a channel failure', async t => {
  const store = fixture(t);
  const started = deferred();
  const router = createRouter({ store, stream: async function* ({ signal }) {
    started.resolve();
    await sleep(60_000, undefined, { signal });
    yield { type: 'delta', text: 'not reached' };
  } });
  const controller = new AbortController();
  const result = collect(router.run(input({ signal: controller.signal, requestId: 'cancelled' })));
  await started.promise;
  controller.abort();
  await assert.rejects(result, error => error.name === 'AbortError');
  assert.equal(model(store, 'a').failure_count, 0);
  assert.equal(store.get('SELECT outcome FROM route_attempts').outcome, 'stopped');
});

test('cancelled half-open probe releases its slot for the next request', async t => {
  const now = Date.parse('2026-09-29T00:02:00Z');
  const store = fixture(t, [{ id: 'a', failureCount: 3, cooldownUntil: '2026-09-29T00:01:00Z' }]);
  const started = deferred();
  let calls = 0;
  const router = createRouter({ store, clock: () => now, stream: async function* ({ signal }) {
    if (++calls === 1) { started.resolve(); await sleep(60_000, undefined, { signal }); }
    yield { type: 'delta', text: 'Recovered' };
  } });
  const controller = new AbortController();
  const first = collect(router.run(input({ signal: controller.signal })));
  await started.promise;
  controller.abort();
  await assert.rejects(first, error => error.name === 'AbortError');
  assert.equal(model(store, 'a').failure_count, 3);
  assert.deepEqual(selected(await collect(router.run(input()))), ['a']);
});

test('aborting during retry delay prevents additional attempts', async t => {
  const store = fixture(t);
  const failed = deferred();
  let calls = 0;
  const controller = new AbortController();
  const router = createRouter({ store, stream: async function* () { calls++; failed.resolve(); throw failure(); } });
  const result = collect(router.run(input({ signal: controller.signal })));
  await failed.promise;
  await sleep(10);
  controller.abort();
  await assert.rejects(result, error => error.name === 'AbortError');
  assert.equal(calls, 1);
  assert.equal(model(store, 'a').failure_count, 1);
});

test('image messages only route through explicitly vision-capable equivalent models', async t => {
  const store = fixture(t, [{ id: 'a', priority: 10 }, { id: 'b', vision: 1 }]);
  const router = createRouter({ store, stream: async function* ({ model: candidate }) {
    assert.equal(candidate.vision, true);
    yield { type: 'delta', text: 'Image answer' };
  } });
  const result = await collect(router.run(input({ messages: [{ role: 'user', content: '', attachments: [{ kind: 'image' }] }] })));
  assert.deepEqual(selected(result), ['b']);
  assert.equal(model(store, 'a').failure_count, 0);
});

test('failed channels never fall back to a different route key', async t => {
  const store = fixture(t, [{ id: 'a' }, { id: 'b', routeKey: 'cheaper-model' }]);
  let count = 0;
  const router = createRouter({ store, stream: async function* () { count++; throw failure(429); } });
  await assert.rejects(collect(router.run(input())), { code: 'ROUTE_EXHAUSTED' });
  assert.equal(count, 1);
});

test('all channels cooling down are skipped without paid requests', async t => {
  const store = fixture(t, [{ id: 'a', cooldownUntil: '2099-01-01T00:00:00Z' }]);
  let called = false;
  const router = createRouter({ store, stream: async function* () { called = true; } });
  await assert.rejects(collect(router.run(input())), { code: 'ROUTE_COOLDOWN' });
  assert.equal(called, false);
  assert.equal(model(store, 'a').failure_count, 0);
});

test('late failure cannot overwrite a newer successful health reset', async t => {
  const store = fixture(t);
  const firstStarted = deferred(), releaseFailure = deferred();
  let calls = 0;
  const router = createRouter({ store, stream: async function* ({ model: candidate }) {
    if (candidate.id === 'a' && calls++ === 0) { firstStarted.resolve(); await releaseFailure.promise; throw failure(429); }
    yield { type: 'delta', text: 'OK' };
  } });
  const first = collect(router.run(input()));
  await firstStarted.promise;
  await collect(router.run(input()));
  releaseFailure.resolve();
  await first;
  assert.equal(model(store, 'a').failure_count, 0);
  assert.equal(model(store, 'a').status, 'ok');
});

test('audit log never stores unknown exception text containing credentials', async t => {
  const store = fixture(t);
  const router = createRouter({ store, stream: async function* () { throw new Error('Authorization: secret-a'); } });
  await assert.rejects(collect(router.run(input({ requestId: 'secret-test' }))));
  const audit = store.get('SELECT * FROM route_attempts');
  assert.ok(!JSON.stringify(audit).includes('secret-a'));
  assert.equal(model(store, 'a').failure_count, 0);
});

test('consumer stopping iteration releases a half-open probe without a health penalty', async t => {
  const now = Date.parse('2026-09-29T00:02:00Z');
  const store = fixture(t, [{ id: 'a', failureCount: 3, cooldownUntil: '2026-09-29T00:01:00Z' }]);
  const router = createRouter({ store, clock: () => now, stream: async function* () { yield { type: 'delta', text: 'OK' }; } });
  const iterator = router.run(input());
  assert.equal((await iterator.next()).value.type, 'selected');
  await iterator.return();
  assert.equal(model(store, 'a').failure_count, 3);
  assert.deepEqual(selected(await collect(router.run(input()))), ['a']);
});


test('Work tools commit the attempt before text and forbid failover on later outage', async t => {
  const store = fixture(t, [{ id:'a', protocol:'anthropic' }, { id:'b', protocol:'anthropic' }]);
  const called = [];
  const router = createRouter({store,stream:async function* ({provider}) {
    called.push(provider.id);
    yield {type:'activity',label:'Writing file',committed:true};
    throw failure(503);
  }});
  await assert.rejects(collect(router.run(input({mode:'work',requestId:'work-side-effect'}))), {upstreamStatus:503});
  assert.deepEqual(called,['a']);
});

test('Work accepts native API channels and still filters unsupported effort', async t => {
  const store=fixture(t,[{id:'a',protocol:'openai-chat',priority:100,efforts:['high']},{id:'b',protocol:'anthropic',priority:80,efforts:[]},{id:'c',protocol:'anthropic',runtime:'claude-code',efforts:['high']}]);
  const calls=[];
  const router=createRouter({store,stream:async function* (options) { calls.push(options); yield {type:'delta',text:'OK'}; }});
  await collect(router.run(input({mode:'work',effort:'high',context:{userId:'owner',chatId:'chat'}})));
  assert.equal(calls.length,1);
  assert.equal(calls[0].provider.id,'a');
  assert.equal(calls[0].provider.runtime,'api');
  assert.equal(calls[0].effort,'high');
  assert.equal(calls[0].context.userId,'owner');
});

test('model versions fail over only within the selected version, including the unversioned route', async t => {
  const store = fixture(t, [{ id: 'normal', priority: 100, variantName: '普通版' }, { id: 'smart-a', priority: 10, variantName: '高智商版' }, { id: 'smart-b', variantName: '高智商版' }, { id: 'legacy', priority: 200 }]);
  const calls = [];
  const router = createRouter({ store, stream: async function* ({ model }) { calls.push(model.id); if (model.id === 'smart-a') throw failure(429); yield { type: 'delta', text: '回答' }; } });
  assert.deepEqual(selected(await collect(router.run(input({ variantName: '高智商版' })))), ['smart-a', 'smart-b']);
  assert.deepEqual(selected(await collect(router.run(input()))), ['legacy']);
  assert.deepEqual(selected(await collect(router.run(input({ variantName: '普通版' })))), ['normal']);
  await assert.rejects(collect(router.run(input({ variantName: '不存在的版本' }))), { code: 'ROUTE_UNAVAILABLE' });
  assert.equal(calls.length, 4);
  const output = [];
  await assert.rejects(collect(router.run(input({ variantName: '高智商版', candidateIds: ['normal'] })), output), { code: 'ROUTE_UNAVAILABLE' });
  assert.deepEqual(output, []);
});

test('a version assignment changed during routing is rechecked before failover', async t => {
  const store = fixture(t, [{ id: 'a', priority: 10, variantName: '高智商版' }, { id: 'b', variantName: '高智商版' }]);
  const calls = [];
  const router = createRouter({ store, stream: async function* ({ model }) {
    calls.push(model.id);
    store.run('UPDATE models SET variant_name=? WHERE id=?', '普通版', 'b');
    throw failure(429);
  } });
  await assert.rejects(collect(router.run(input({ variantName: '高智商版' }))), { code: 'ROUTE_EXHAUSTED' });
  assert.deepEqual(calls, ['a']);
});

test('disabled provider failure protection ignores persisted cooldown and continues tracking errors without disabling', async t => {
  const store = fixture(t, [{ id: 'a', protection: 0, threshold: 1, failureCount: 9, cooldownUntil: '2099-01-01T00:00:00Z' }]);
  let calls = 0;
  const router = createRouter({ store, stream: async function* () { calls++; throw failure(429); } });
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(collect(router.run(input())), { code: 'ROUTE_EXHAUSTED' });
  assert.equal(calls, 3); assert.equal(model(store, 'a').failure_count, 12); assert.equal(model(store, 'a').cooldown_until, null);
});

test('per-model failure protection can override either enabled or disabled provider defaults', async t => {
  const store = fixture(t, [{ id: 'a', protection: 1, modelProtection: 0, threshold: 1 }, { id: 'b', protection: 0, modelProtection: 1, threshold: 1, modelCooldownSeconds: 120 }]);
  const stamp = Date.parse('2026-10-01T00:00:00Z');
  const router = createRouter({ store, clock: () => stamp, stream: async function* () { throw failure(429); } });
  await assert.rejects(collect(router.run(input())), { code: 'ROUTE_EXHAUSTED' });
  assert.equal(model(store, 'a').cooldown_until, null);
  assert.equal(model(store, 'b').cooldown_until, '2026-10-01T00:02:00.000Z');
  const events = [];
  await assert.rejects(collect(router.run(input()), events), { code: 'ROUTE_EXHAUSTED' });
  assert.deepEqual(selected(events), ['a']);
});

test('per-model threshold and cooldown override provider defaults and allow recovery afterwards', async t => {
  const store = fixture(t, [{ id: 'a', threshold: 1, cooldownSeconds: 60, modelThreshold: 2, modelCooldownSeconds: 300 }]);
  let now = Date.parse('2026-10-01T00:00:00Z'), fail = true;
  const router = createRouter({ store, clock: () => now, stream: async function* () { if (fail) throw failure(429); yield { type: 'delta', text: '恢复' }; } });
  await assert.rejects(collect(router.run(input())), { code: 'ROUTE_EXHAUSTED' });
  assert.equal(model(store, 'a').cooldown_until, null);
  await assert.rejects(collect(router.run(input())), { code: 'ROUTE_EXHAUSTED' });
  assert.equal(model(store, 'a').cooldown_until, '2026-10-01T00:05:00.000Z');
  await assert.rejects(collect(router.run(input())), { code: 'ROUTE_COOLDOWN' });
  now += 300_001; fail = false;
  assert.deepEqual(selected(await collect(router.run(input()))), ['a']);
  assert.equal(model(store, 'a').failure_count, 0); assert.equal(model(store, 'a').cooldown_until, null);
});
