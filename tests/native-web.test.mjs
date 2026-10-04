import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { runNativeAgent, nativeTools } from '../runner/native-agent.mjs';
import { initialSearchQuery } from '../runner/native-web.mjs';
import { createBroker } from '../runner/broker.mjs';
import { DEFAULT_LIMITS } from '../runner/protocol.mjs';

const baseJob = protocol => ({ protocol, model: 'test-model', mode: 'work', prompt: 'Conversation data:\n[{"role":"user","content":"旧问题"},{"role":"assistant","content":"旧回答"},{"role":"user","content":"今天的天气"}]', systemPrompt: '', skills: [], images: [], webSearch: true, gateway: 'http://gateway:3210/proxy/job', jobToken: 'short-lived-job-key', limits: { ...DEFAULT_LIMITS } });
function answer(protocol, text) {
  return Response.json(protocol === 'anthropic' ? { content: [{ type: 'text', text }], stop_reason: 'end_turn' }
    : protocol === 'openai-responses' ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }
      : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] });
}

test('search query uses only the latest user text and all native protocols offer controlled functions', () => {
  assert.equal(initialSearchQuery(baseJob('openai-chat').prompt), '今天的天气');
  assert.equal(initialSearchQuery('x'.repeat(1000)).length, 500);
  for (const protocol of ['anthropic', 'openai-chat', 'openai-responses']) {
    const tools = nativeTools(protocol, { webSearch: true });
    assert.ok(tools.some(tool => (tool.name ?? tool.function?.name) === 'web_search'));
    assert.ok(tools.some(tool => (tool.name ?? tool.function?.name) === 'web_fetch'));
    assert.ok(!tools.some(tool => /web_search/.test(tool.type ?? '')));
    assert.ok(!nativeTools(protocol).some(tool => /web_/.test(tool.name ?? tool.function?.name ?? '')));
  }
});

for (const protocol of ['anthropic', 'openai-chat', 'openai-responses']) test(`${protocol} searches before answering and supplies actual results to the model without provider-native search`, async () => {
  const events = [], urls = []; let finalState;
  await runNativeAgent(baseJob(protocol), { emit: event => { events.push(event); if (event.type === 'checkpoint') finalState = event.state; }, fetcher: async (url, options) => {
    urls.push(url); const body = JSON.parse(options.body);
    if (url.endsWith('/web/search')) {
      assert.equal(options.headers.Authorization, 'Bearer short-lived-job-key'); assert.equal(body.query, '今天的天气');
      return Response.json({ query: body.query, results: [{ title: 'Live result', url: 'https://example.com/weather', content: 'Fresh fetched result' }] });
    }
    assert.match(JSON.stringify(body), /Fresh fetched result/); assert.match(JSON.stringify(body), /https:\/\/example.com\/weather/);
    return answer(protocol, '基于搜索结果回答。');
  } });
  assert.ok(urls[0].endsWith('/web/search')); assert.equal(urls.length, 2);
  assert.ok(events.some(event => event.type === 'activity' && /找到 1 条/.test(event.label)));
  assert.ok(!events.some(event => event.type === 'activity' && event.committed));
  let resumeSearches = 0;
  await runNativeAgent({ ...baseJob(protocol), resumeState: finalState, continuation: true, resumeText: finalState.visibleText }, { fetcher: async url => { if (url.includes('/web/')) resumeSearches++; return answer(protocol, '继续回答。'); } });
  assert.equal(resumeSearches, 0);
});

test('failed live search is recorded as an error and a failed activity, never as successful browsing', async () => {
  const events = []; let modelBody;
  await runNativeAgent(baseJob('openai-chat'), { emit: event => events.push(event), fetcher: async (url, options) => {
    if (url.endsWith('/web/search')) return Response.json({ error: '搜索服务暂不可用。' }, { status: 503 });
    modelBody = JSON.parse(options.body); return answer('openai-chat', '搜索失败。');
  } });
  assert.match(JSON.stringify(modelBody), /搜索服务暂不可用/);
  assert.ok(events.some(event => /联网搜索失败/.test(event.label || '')));
  assert.ok(!events.some(event => /搜索完成/.test(event.label || '')));
});

test('model-invoked webpage fetch uses the same controlled gateway and returns its real content', async () => {
  const urls = []; let turns = 0;
  await runNativeAgent(baseJob('openai-chat'), { fetcher: async (url, options) => {
    urls.push(url);
    if (url.endsWith('/web/search')) return Response.json({ results: [{ url: 'https://example.com/page' }] });
    if (url.endsWith('/web/read')) { assert.deepEqual(JSON.parse(options.body), { url: 'https://example.com/page' }); return Response.json({ url: 'https://example.com/page', text: 'Page content actually fetched.' }); }
    if (++turns === 1) return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'fetch-page', type: 'function', function: { name: 'web_fetch', arguments: '{"url":"https://example.com/page"}' } }] } }] });
    assert.match(options.body, /Page content actually fetched/); return answer('openai-chat', '网页结果。');
  } });
  assert.equal(urls.filter(url => url.endsWith('/web/read')).length, 1);
});

test('web gateway enforces task credentials, enabled flags, body fields and a shared per-job call ceiling', async t => {
  const calls = [], broker = createBroker({ token: 's'.repeat(43), self: 'test-broker', docker: async () => '', webAccess: { search: async (body, options) => { calls.push({ body, options }); return { results: [] }; }, read: async body => { calls.push(body); return { text: 'read' }; } } });
  broker.server.listen(0, '127.0.0.1'); await once(broker.server, 'listening'); t.after(() => broker.close());
  const id = 'a'.repeat(32), jobToken = 'b'.repeat(43);
  const task = { id, network: 'test', jobToken, config: { mode: 'work', webSearch: true, search: { enabled: true, baseUrl: 'http://work-search:8080' } }, controller: new AbortController() };
  broker.jobs.set(id, task);
  const base = `http://127.0.0.1:${broker.server.address().port}/proxy/${id}/web/`;
  const request = (body = { query: 'test' }, token = jobToken, endpoint = 'search') => fetch(base + endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await request(undefined, 'wrong')).status, 401);
  assert.equal((await request({ query: 'test', baseUrl: 'http://internal' })).status, 400);
  for (const config of [{ mode: 'chat', webSearch: true, search: { enabled: true } }, { mode: 'work', webSearch: false, search: { enabled: true } }, { mode: 'work', webSearch: true, search: { enabled: false } }]) {
    const old = task.config; task.config = config; assert.equal((await request()).status, 403); task.config = old;
  }
  assert.equal((await request({ query: 'x'.repeat(18000) })).status, 413);
  task.webCalls = 0;
  assert.equal((await request()).status, 200); assert.equal(calls[0].options.baseUrl, 'http://work-search:8080'); assert.equal(calls[0].options.signal, task.controller.signal);
  for (let index = 1; index < 20; index++) assert.equal((await request({ url: 'https://example.com' }, jobToken, 'read')).status, 200);
  assert.equal((await request()).status, 429); assert.equal(calls.length, 20);
  broker.jobs.delete(id); assert.equal((await request()).status, 401);
});
