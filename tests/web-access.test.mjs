import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebAccess } from '../runner/web-access.mjs';

const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const fixture = responses => {
  const calls = [], cleaned = [];
  const web = createWebAccess({
    async publicRequest(url, options) { calls.push({ url, options, internal: false }); const response = await responses(url, options); return { response, cleanup: async () => cleaned.push(url) }; },
    async internalFetch(url, options) { calls.push({ url, options, internal: true }); return responses(url, options); }
  });
  return { web, calls, cleaned };
};

test('search uses the fixed internal SearXNG JSON endpoint and normalizes bounded public results', async () => {
  const f = fixture(() => json({ results: [
    { title: '<b>今日 &amp; 公告</b>', url: 'https://news.example.com/today#part', content: '<p>新鲜资讯</p><script>do_not_return()</script>' },
    { title: 'duplicate', url: 'https://news.example.com/today', content: 'duplicate' },
    { title: 'private', url: 'https://127.0.0.1/secret', content: 'private' },
    { title: 'data', url: 'https://api.example.com/route', content: '公共交通数据' }
  ] }));
  const result = await f.web.search({ query: '  今日公交 & 新闻  ', limit: 2 });
  assert.equal(result.query, '今日公交 & 新闻'); assert.equal(result.results.length, 2);
  assert.deepEqual(result.results[0], { title: '今日 & 公告', url: 'https://news.example.com/today', snippet: '新鲜资讯' });
  assert.ok(Number.isFinite(Date.parse(result.retrievedAt)));
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].internal, true);
  const requested = new URL(f.calls[0].url);
  assert.equal(requested.origin, 'http://work-search:8080'); assert.equal(requested.pathname, '/search'); assert.equal(requested.searchParams.get('q'), result.query); assert.equal(requested.searchParams.get('format'), 'json');
  assert.equal(f.calls[0].options.redirect, 'manual'); assert.equal(f.calls[0].options.method, 'GET');
});

test('custom search addresses always use the public network validator and never gain internal fetch access', async () => {
  const f = fixture(() => json({ results: [{ url: 'https://example.com/result', title: '结果', content: '介绍' }] }));
  await f.web.search({ query: 'test' }, { baseUrl: 'https://search.example.com/prefix/' });
  assert.equal(f.calls[0].url, 'https://search.example.com/prefix/search?q=test&format=json'); assert.equal(f.calls[0].internal, false); assert.deepEqual(f.cleaned, [f.calls[0].url]);
  for (const baseUrl of ['http://work-search:8080.evil.test', 'http://work-search:8080/private', 'http://127.0.0.1:8080', 'https://192.168.1.1', 'https://search.example.com/?key=secret', 'https://user:password@search.example.com']) {
    await assert.rejects(f.web.search({ query: 'test' }, { baseUrl }), error => error.status === 400);
  }
  assert.equal(f.calls.length, 1);
});

test('search rejects invalid queries, empty results, non-JSON responses and oversized responses explicitly', async () => {
  const f = fixture(() => json({ results: [] }));
  for (const input of [{}, { query: '' }, { query: 'x'.repeat(501) }, { query: 'bad\nquery' }, { query: 'test', limit: 0 }, { query: 'test', limit: 11 }, { query: 'test', limit: 1.5 }]) await assert.rejects(f.web.search(input), error => error.status === 400);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.web.search({ query: 'none' }), error => error.status === 404 && /未找到/.test(error.message));
  await assert.rejects(fixture(() => new Response('<html>captcha</html>')).web.search({ query: 'test' }), /JSON API/);
  await assert.rejects(fixture(() => new Response('failure', { status: 503 })).web.search({ query: 'test' }), /HTTP 503/);
  await assert.rejects(fixture(() => new Response('x'.repeat(2 * 1024 * 1024 + 1))).web.search({ query: 'test' }), /超过大小限制/);
});

test('read follows at most three public redirects and extracts HTML without scripts or hidden markup', async () => {
  const f = fixture(url => url.endsWith('/start') ? new Response(null, { status: 302, headers: { location: '/final' } }) : new Response('<html><head><title>公交 &amp; 资讯</title><style>secret-style</style></head><body><h1>实时路线</h1><p>时间：12:34，线路 &#x32;&#48;。</p><script>secret-script()</script><noscript>hidden fallback</noscript><iframe>secret-frame</iframe><p>结束</p></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  const result = await f.web.read({ url: 'https://example.com/start#heading' });
  assert.equal(result.url, 'https://example.com/final'); assert.equal(result.title, '公交 & 资讯'); assert.equal(result.text, '实时路线\n\n时间：12:34，线路 20。\n\n结束'); assert.equal(result.truncated, false);
  assert.ok(!result.text.includes('secret') && !result.text.includes('hidden')); assert.ok(f.calls.every(call => call.options.allowRedirect === true && call.internal === false)); assert.equal(f.cleaned.length, 2);
});

test('read rejects private or credential-bearing redirect destinations before issuing another request', async () => {
  for (const destination of ['https://127.0.0.1/admin', 'https://[::1]/', 'https://10.0.0.1/', 'https://192.168.1.1/', 'http://work-search:8080', 'file:///etc/passwd', 'https://user:secret@example.com/']) {
    const f = fixture(() => new Response(null, { status: 302, headers: { location: destination } }));
    await assert.rejects(f.web.read({ url: 'https://example.com/start' }), error => error.status === 400);
    assert.equal(f.calls.length, 1); assert.equal(f.cleaned.length, 1);
  }
  const blockedDns = createWebAccess({ publicRequest: async () => { throw Object.assign(new Error('已拒绝访问本机、内网或保留地址。'), { status: 400 }); } });
  await assert.rejects(blockedDns.read({ url: 'https://rebinding.example.com/' }), /已拒绝/);
});

test('read handles public JSON and plaintext data and bounds extracted output with an explicit truncation marker', async () => {
  const data = '{"route":"20","eta":"2026-10-05T12:00:00+08:00"}';
  const jsonResult = await fixture(() => new Response(data, { headers: { 'content-type': 'application/json' } })).web.read({ url: 'https://api.example.com/eta' });
  assert.equal(jsonResult.text, data); assert.equal(jsonResult.title, 'api.example.com'); assert.equal(jsonResult.truncated, false);
  const long = await fixture(() => new Response('x'.repeat(30_100), { headers: { 'content-type': 'text/plain' } })).web.read({ url: 'https://example.com/plain' });
  assert.equal(long.text.length, 30_000); assert.equal(long.truncated, true);
  await assert.rejects(fixture(() => new Response('pdf', { headers: { 'content-type': 'application/pdf' } })).web.read({ url: 'https://example.com/file.pdf' }), error => error.status === 415);
  await assert.rejects(fixture(() => new Response('x', { headers: { 'content-type': 'text/plain', 'content-length': '3000000' } })).web.read({ url: 'https://example.com/large' }), /超过大小限制/);
});

test('redirect loops, excessive redirects and cancelled requests do not continue fetching', async () => {
  const loop = fixture(() => new Response(null, { status: 302, headers: { location: '/same' } }));
  await assert.rejects(loop.web.read({ url: 'https://example.com/same' }), /循环/); assert.equal(loop.calls.length, 1);
  let i = 0; const many = fixture(() => new Response(null, { status: 302, headers: { location: `/next-${++i}` } }));
  await assert.rejects(many.web.read({ url: 'https://example.com/start' }), /次数过多/); assert.equal(many.calls.length, 4); assert.equal(many.cleaned.length, 4);
  const controller = new AbortController(), cancelled = fixture(() => json({ results: [] })); controller.abort(new Error('stop'));
  await assert.rejects(cancelled.web.search({ query: 'test' }, { signal: controller.signal }), /stop/);
  await assert.rejects(cancelled.web.read({ url: 'https://example.com/' }, { signal: controller.signal }), /stop/); assert.equal(cancelled.calls.length, 0);
});
