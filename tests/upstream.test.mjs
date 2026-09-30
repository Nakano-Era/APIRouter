import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { listModels, streamReply, validateBaseUrl, sanitizeUpstreamError, UpstreamError } from '../server/upstream.mjs';
import { apiUrl, classifyAddress } from '../server/net.mjs';

const originalPrivate = process.env.ALLOW_PRIVATE_UPSTREAM;
before(() => { process.env.ALLOW_PRIVATE_UPSTREAM = 'true'; });
after(() => {
  if (originalPrivate === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM;
  else process.env.ALLOW_PRIVATE_UPSTREAM = originalPrivate;
});

async function mock(t, handler) {
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const part of req) raw += part;
      const body = raw ? JSON.parse(raw) : null;
      await handler(req, res, body);
    } catch (error) { res.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, protocol: 'openai-chat', apiKey: 'secret-test-key' };
}
const options = provider => ({ provider, model: { modelId: 'test-model', vision: false }, messages: [{ role: 'user', content: '你好', attachments: [] }], maxOutputTokens: 500, systemPrompt: 'Be helpful.' });
async function collect(input) { const output = []; for await (const item of streamReply(input)) output.push(item); return output; }
const frame = data => `data: ${JSON.stringify(data)}\r\n\r\n`;

test('base URL validation and versioned endpoint joining', () => {
  assert.equal(validateBaseUrl('https://anyrouter.top/v1/'), 'https://anyrouter.top/v1');
  assert.equal(apiUrl('https://example.com', 'models'), 'https://example.com/v1/models');
  assert.equal(apiUrl('https://example.com/proxy/v1/', 'responses'), 'https://example.com/proxy/v1/responses');
  for (const url of ['file:///etc/passwd', 'https://a:b@example.com', 'https://example.com?key=secret', 'https://example.com#fragment', 'https://example.com?', 'https://192.168.1.1', 'https://169.254.169.254', 'https://[::ffff:10.0.0.1]', 'http://example.com', 'https://local.internal']) {
    assert.throws(() => validateBaseUrl(url), UpstreamError, url);
  }
  process.env.ALLOW_PRIVATE_UPSTREAM = 'false';
  try {
    for (const url of ['http://127.0.0.1', 'https://localhost', 'https://[::1]', 'https://2130706433', 'https://127.1']) assert.throws(() => validateBaseUrl(url), UpstreamError);
  } finally { process.env.ALLOW_PRIVATE_UPSTREAM = 'true'; }
});

test('IP classifier excludes private, special, and IPv6 transition addresses', () => {
  for (const address of ['10.0.0.1', '172.16.2.2', '192.168.2.3', '100.64.0.1', '169.254.1.1', '0.0.0.0', '224.0.0.1', '198.18.0.1', '192.0.2.1', '::', 'fc00::1', 'fe80::1', '::ffff:192.168.1.1', '64:ff9b::a00:1', '2002:0a00:0001::', '2001:db8::1']) assert.equal(classifyAddress(address), 'blocked', address);
  assert.equal(classifyAddress('::ffff:127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('8.8.8.8'), 'public');
  assert.equal(classifyAddress('2606:4700:4700::1111'), 'public');
});

test('model list normalizes real records and keeps credentials in request headers', async t => {
  let requested;
  const provider = await mock(t, (req, res) => {
    requested = req;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'gpt-a' }, { id: 'claude-b', display_name: 'Claude B' }, { id: 'gpt-a' }, { no: 'id' }] }));
  });
  const result = await listModels({ ...provider, baseUrl: `${provider.baseUrl}/v1/` });
  assert.deepEqual(result, [{ modelId: 'gpt-a', name: 'gpt-a' }, { modelId: 'claude-b', name: 'Claude B' }]);
  assert.equal(requested.url, '/v1/models');
  assert.equal(requested.headers.authorization, 'Bearer secret-test-key');
  assert.ok(!JSON.stringify(result).includes(provider.apiKey));
});

test('validated hostname resolution is used by the outgoing connection', async t => {
  const provider = await mock(t, (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{"data":[{"id":"local"}]}');
  });
  assert.deepEqual(await listModels({ ...provider, baseUrl: provider.baseUrl.replace('127.0.0.1', 'localhost') }), [{ modelId: 'local', name: 'local' }]);
});

test('Anthropic model sync authenticates and follows pagination without dropping models', async t => {
  const seen = [];
  const provider = await mock(t, (req, res) => {
    assert.equal(req.headers['x-api-key'], 'secret-test-key');
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    assert.equal(req.headers.authorization, undefined);
    const url = new URL(req.url, 'http://example.com');
    seen.push(url.searchParams.get('after_id'));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(seen.length === 1
      ? { data: [{ id: 'one', display_name: 'One' }], has_more: true, last_id: 'one' }
      : { data: [{ id: 'two', display_name: 'Two' }], has_more: false }));
  });
  assert.deepEqual(await listModels({ ...provider, protocol: 'anthropic' }), [{ modelId: 'one', name: 'One' }, { modelId: 'two', name: 'Two' }]);
  assert.deepEqual(seen, [null, 'one']);
});

test('explicit bearer auth works with Anthropic protocol without sending duplicate credentials', async t => {
  const provider = await mock(t, (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer secret-test-key');
    assert.equal(req.headers['x-api-key'], undefined);
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    res.setHeader('content-type', 'application/json');
    res.end('{"data":[{"id":"claude"}]}');
  });
  assert.deepEqual(await listModels({ ...provider, protocol: 'anthropic', authMode: 'bearer' }), [{ modelId: 'claude', name: 'claude' }]);
});

test('explicit x-api-key auth is supported for a compatible OpenAI endpoint', async t => {
  const provider = await mock(t, (req, res) => {
    assert.equal(req.headers['x-api-key'], 'secret-test-key');
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('content-type', 'application/json');
    res.end('{"data":[{"id":"custom"}]}');
  });
  assert.deepEqual(await listModels({ ...provider, authMode: 'x-api-key' }), [{ modelId: 'custom', name: 'custom' }]);
});

test('Chat SSE handles split UTF-8 and CRLF frames and reports token usage', async t => {
  let requestBody;
  const provider = await mock(t, async (req, res, body) => {
    assert.equal(req.url, '/v1/chat/completions');
    requestBody = body;
    res.setHeader('content-type', 'text/event-stream');
    const data = Buffer.from(frame({ choices: [{ index: 0, delta: { content: '你好 🌍' } }] }) + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + frame({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } }) + 'data: [DONE]\r\n\r\n');
    for (let i = 0; i < data.length; i += 3) { res.write(data.subarray(i, i + 3)); await delay(1); }
    res.end();
  });
  const result = await collect(options(provider));
  assert.deepEqual(result, [{ type: 'delta', text: '你好 🌍' }, { type: 'usage', inputTokens: 9, outputTokens: 4 }]);
  assert.equal(requestBody.messages[0].role, 'system');
  assert.equal(requestBody.max_completion_tokens, 500);
  assert.equal(requestBody.stream, true);
});

test('Responses SSE maps endpoint, text, completion, and assistant history', async t => {
  let input;
  const provider = await mock(t, (req, res, body) => {
    assert.equal(req.url, '/proxy/v1/responses');
    input = body;
    res.setHeader('content-type', 'text/event-stream');
    res.end(frame({ type: 'response.output_text.delta', delta: 'Ready' }) + frame({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Ready' }] }], usage: { input_tokens: 5, output_tokens: 2 } } }));
  });
  const request = options({ ...provider, baseUrl: `${provider.baseUrl}/proxy/v1`, protocol: 'openai-responses' });
  request.messages.push({ role: 'assistant', content: 'Previous answer' }, { role: 'user', content: 'Continue' });
  assert.deepEqual(await collect(request), [{ type: 'delta', text: 'Ready' }, { type: 'usage', inputTokens: 5, outputTokens: 2 }]);
  assert.equal(input.input[1].content[0].type, 'output_text');
  assert.equal(input.max_output_tokens, 500);
  assert.equal(input.store, false);
  assert.equal(input.instructions, 'Be helpful.');
});

test('Anthropic SSE emits text and cumulative input/output usage', async t => {
  let input;
  const provider = await mock(t, (req, res, body) => {
    assert.equal(req.url, '/v1/messages');
    assert.equal(req.headers['x-api-key'], 'secret-test-key');
    input = body;
    res.setHeader('content-type', 'text/event-stream');
    res.end(frame({ type: 'message_start', message: { usage: { input_tokens: 3, cache_read_input_tokens: 10, output_tokens: 1 } } }) + frame({ type: 'content_block_start', content_block: { type: 'text', text: '' } }) + frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: '完成' } }) + frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }) + frame({ type: 'message_stop' }));
  });
  assert.deepEqual(await collect(options({ ...provider, protocol: 'anthropic' })), [{ type: 'delta', text: '完成' }, { type: 'usage', inputTokens: 13, outputTokens: 7 }]);
  assert.equal(input.max_tokens, 500);
  assert.equal(input.system, 'Be helpful.');
});

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic']) {
  test(`${protocol} supports JSON fallback and carries extracted text plus image attachments`, async t => {
    let body;
    const provider = await mock(t, (_req, res, input) => {
      body = input;
      res.setHeader('content-type', 'application/json');
      const result = protocol === 'openai-chat' ? { choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] }
        : protocol === 'openai-responses' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }] }
          : { content: [{ type: 'text', text: 'answer' }], stop_reason: 'end_turn' };
      res.end(JSON.stringify(result));
    });
    const request = options({ ...provider, protocol });
    request.model.vision = true;
    request.messages[0].attachments = [{ kind: 'text', name: 'notes.txt', text: 'Document contents' }, { kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,YWJj' }];
    assert.deepEqual(await collect(request), [{ type: 'delta', text: 'answer' }]);
    assert.ok(JSON.stringify(body).includes('Document contents'));
    assert.ok(JSON.stringify(body).includes(protocol === 'anthropic' ? 'YWJj' : 'data:image/png;base64,YWJj'));
  });
}

test('nonvision image use fails before any network request', async () => {
  const request = options({ baseUrl: 'https://invalid.invalid', protocol: 'openai-chat', apiKey: 'unused' });
  request.messages[0].attachments = [{ kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,YWJj' }];
  await assert.rejects(collect(request), { code: 'VISION_UNSUPPORTED' });
});

test('redirects never forward credentials to their target', async t => {
  let reached = false;
  const target = await mock(t, (_req, res) => { reached = true; res.end('{}'); });
  const source = await mock(t, (_req, res) => { res.writeHead(302, { location: `${target.baseUrl}/capture` }); res.end(); });
  await assert.rejects(listModels(source), { code: 'UPSTREAM_REDIRECT' });
  assert.equal(reached, false);
});

test('upstream HTTP and stream errors never expose raw provider messages or secrets', async t => {
  const provider = await mock(t, (_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"secret-test-key private stack trace"}}'); });
  await assert.rejects(listModels(provider), error => {
    assert.equal(error.upstreamStatus, 401);
    assert.ok(!sanitizeUpstreamError(error).includes('secret-test-key'));
    assert.ok(!sanitizeUpstreamError(error).includes('stack'));
    return true;
  });
  assert.ok(!sanitizeUpstreamError(new Error('secret-test-key')).includes('secret-test-key'));
});

test('fixed admin probes get bounded redacted JSON diagnostics without changing public errors', async t => {
  const provider = await mock(t, (_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: {
      type: 'invalid_request_error', code: 'model_not_found',
      message: 'Model is unavailable. secret-test-key Bearer another-token sk-upstream-secret https://provider.example/path?token=private user@example.com',
      stack: 'private stack must never appear',
    }, debug: 'private debug must never appear' }));
  });
  const check = diagnostics => assert.rejects(collect({ ...options(provider), diagnostics }), error => {
    assert.equal(error.code, 'UPSTREAM_HTTP_ERROR');
    assert.equal(error.status, 502);
    assert.equal(error.upstreamStatus, 400);
    assert.match(sanitizeUpstreamError(error), /请求参数被上游拒绝/);
    assert.doesNotMatch(sanitizeUpstreamError(error), /Model is unavailable|model_not_found/);
    if (diagnostics) {
      assert.match(error.adminDetail, /model_not_found.*Model is unavailable/);
      assert.doesNotMatch(error.adminDetail, /secret-test-key|another-token|sk-upstream-secret|provider\.example|user@example\.com|private/);
      assert.equal(error.adminDiagnostic.version, 2);
      assert.equal(error.adminDiagnostic.protocol, 'openai-chat');
      assert.equal(error.adminDiagnostic.method, 'POST');
      assert.equal(error.adminDiagnostic.path, '/v1/chat/completions');
      assert.equal(error.adminDiagnostic.modelId, 'test-model');
      assert.equal(error.adminDiagnostic.upstreamStatus, 400);
      assert.equal(typeof error.adminDiagnostic.authMode, 'string');
      assert.ok(error.adminDiagnostic.authMode.length > 0);
      assert.equal(error.adminDiagnostic.detail, error.adminDetail);
      assert.equal(typeof error.adminDiagnostic.responseFormat, 'string');
      assert.ok(error.adminDiagnostic.responseFormat.length > 0);
      assert.equal(typeof error.adminDiagnostic.note, 'string');
      assert.ok(error.adminDiagnostic.note.length > 0);
      assert.doesNotMatch(JSON.stringify(error.adminDiagnostic), /secret-test-key|another-token|sk-upstream-secret|provider\.example|user@example\.com|private/);
    } else {
      assert.equal(error.adminDetail, undefined);
      assert.equal(error.adminDiagnostic, undefined);
    }
    return true;
  });
  await check(false);
  await check(true);
});

test('admin diagnostics extract safe explanations from common upstream error formats', async t => {
  const cases = [
    ['text/plain', JSON.stringify({ error: { message: 'mislabeled-json: secret-test-key' } }), 'mislabeled-json'],
    ['application/json', JSON.stringify({ msg: 'root-msg: secret-test-key' }), 'root-msg'],
    ['application/json', JSON.stringify({ error: { msg: 'nested-msg: secret-test-key' } }), 'nested-msg'],
    ['application/problem+json', JSON.stringify({ detail: 'problem-detail: secret-test-key' }), 'problem-detail'],
    ['application/json', JSON.stringify({ error_description: 'oauth-description: secret-test-key' }), 'oauth-description'],
    ['text/event-stream', `event: error\n${frame({ type: 'error', error: { type: 'invalid_request_error', message: 'sse-rejection: secret-test-key' } })}`, 'sse-rejection'],
    ['text/plain', 'plain-rejection: this model is unavailable. secret-test-key Bearer private-token', 'plain-rejection'],
  ];
  for (const [contentType, responseBody, marker] of cases) {
    const provider = await mock(t, (_req, res) => { res.writeHead(400, { 'content-type': contentType }); res.end(responseBody); });
    await assert.rejects(collect({ ...options(provider), diagnostics: true }), error => {
      assert.equal(error.code, 'UPSTREAM_HTTP_ERROR');
      assert.equal(error.upstreamStatus, 400);
      assert.ok(error.adminDetail?.includes(marker), `${marker} should be readable by the administrator`);
      assert.equal(error.adminDiagnostic.detail, error.adminDetail);
      assert.ok(error.adminDiagnostic.note?.trim(), `${marker} should include a diagnostic note`);
      assert.ok(error.adminDiagnostic.responseFormat?.trim());
      assert.doesNotMatch(JSON.stringify(error.adminDiagnostic), /secret-test-key|private-token/);
      assert.ok(!sanitizeUpstreamError(error).includes(marker), 'public errors remain generic');
      return true;
    });
  }
});

test('diagnostic fallbacks explain missing detail without exposing HTML, malformed data or stack traces', async t => {
  const cases = [
    ['text/html', '<html>private server error</html>'],
    ['text/html', '<!doctype html><html><title>Just a moment...</title><script>window._cf_chl_opt={secret:"private-challenge-token"}</script><body>Verify you are human</body></html>'],
    ['application/json', '{invalid JSON'],
    ['application/json', JSON.stringify({ error: { message: '<html>private server error</html>' } })],
    ['application/json', JSON.stringify({ error: { message: 'Error\n    at handler (/private/app.mjs:2)' } })],
    ['application/json', JSON.stringify({ error: { message: 'x'.repeat(70_000) } })],
    ['application/json', JSON.stringify({ unknown: 'private unrecognized diagnostic' })],
    ['application/octet-stream', '\u0000\u0001\u0002private binary data'],
    ['application/json', ''],
  ];
  for (const [contentType, responseBody] of cases) {
    const provider = await mock(t, (_req, res) => { res.writeHead(400, { 'content-type': contentType }); res.end(responseBody); });
    await assert.rejects(collect({ ...options(provider), diagnostics: true }), error => {
      assert.equal(error.code, 'UPSTREAM_HTTP_ERROR');
      assert.equal(error.upstreamStatus, 400);
      assert.equal(error.adminDetail, undefined);
      assert.equal(error.adminDiagnostic.detail, undefined);
      assert.ok(error.adminDiagnostic.note?.trim(), `${contentType} fallback must explain why no detail is available`);
      assert.ok(error.adminDiagnostic.responseFormat?.trim());
      assert.doesNotMatch(JSON.stringify(error.adminDiagnostic), /private|invalid JSON|<html>|<script>|Just a moment|Verify you are human/);
      if (contentType === 'text/html') assert.match(`${error.adminDiagnostic.responseFormat} ${error.adminDiagnostic.note}`, /html|浏览器|验证|网页/i);
      return true;
    });
  }
});

test('encoded keys are redacted before diagnostic text is truncated', async t => {
  const key = 'secret/key+with=symbols';
  const provider = await mock(t, (_req, res) => {
    res.writeHead(400, { 'content-type': 'application/problem+json' });
    res.end(JSON.stringify({ message: `Invalid model. ${encodeURIComponent(key)} ${Buffer.from(key).toString('base64')} ${'Please verify model. '.repeat(100)}` }));
  });
  await assert.rejects(collect({ ...options({ ...provider, apiKey: key }), diagnostics: true }), error => {
    assert.match(error.adminDetail, /Invalid model/);
    assert.ok(error.adminDetail.length <= 601);
    assert.doesNotMatch(error.adminDetail, /secret|symbols/);
    assert.ok(!error.adminDetail.includes(Buffer.from(key).toString('base64')));
    return true;
  });
});

test('stalled diagnostic bodies preserve the HTTP error and release the connection', async t => {
  let closed;
  const closePromise = new Promise(resolve => { closed = resolve; });
  const provider = await mock(t, (_req, res) => {
    res.on('close', closed);
    res.writeHead(400, { 'content-type': 'application/json' });
    res.write('{"error":');
  });
  const start = Date.now();
  await assert.rejects(collect({ ...options(provider), diagnostics: true }), error => {
    assert.equal(error.code, 'UPSTREAM_HTTP_ERROR');
    assert.equal(error.upstreamStatus, 400);
    assert.equal(error.adminDetail, undefined);
    assert.equal(error.adminDiagnostic.detail, undefined);
    assert.ok(error.adminDiagnostic.note?.trim());
    assert.match(error.adminDiagnostic.note, /超时|时间|timeout/i);
    return true;
  });
  assert.ok(Date.now() - start < 5000);
  let guard;
  try { await Promise.race([closePromise, new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('diagnostic connection remained open')), 1000); })]); }
  finally { clearTimeout(guard); }
});

test('caller cancellation during diagnostic reading still returns AbortError', async t => {
  let started;
  const startPromise = new Promise(resolve => { started = resolve; });
  const provider = await mock(t, (_req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.write('{'); started(); });
  const controller = new AbortController();
  const result = collect({ ...options(provider), diagnostics: true, signal: controller.signal });
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await startPromise;
  controller.abort();
  await rejected;
});

test('early EOF never marks an unfinished stream complete', async t => {
  const provider = await mock(t, (_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end(frame({ choices: [{ delta: { content: 'partial' } }] })); });
  await assert.rejects(collect(options(provider)), { code: 'UPSTREAM_TRUNCATED_STREAM' });
});

for (const [protocol, data] of [
  ['openai-chat', { choices: [{ delta: { tool_calls: [{ id: 'tool', function: { name: 'run' } }] } }] }],
  ['openai-responses', { type: 'response.output_item.added', item: { type: 'function_call', name: 'run' } }],
  ['anthropic', { type: 'content_block_start', content_block: { type: 'tool_use', name: 'run' } }],
]) {
  test(`${protocol} explicitly rejects unimplemented tool execution`, async t => {
    const provider = await mock(t, (_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end(frame(data)); });
    await assert.rejects(collect(options({ ...provider, protocol })), { code: 'UNSUPPORTED_TOOL_CALL' });
  });
}

test('a reasoning-only response cannot pretend to be a completed visible answer', async t => {
  const provider = await mock(t, (_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'completed', output: [{ type: 'reasoning', summary: [] }] })); });
  await assert.rejects(collect(options({ ...provider, protocol: 'openai-responses' })), { code: 'EMPTY_UPSTREAM_OUTPUT' });
});

test('caller abort cancels a streaming request', async t => {
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const provider = await mock(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); started(); });
  const controller = new AbortController();
  const result = collect({ ...options(provider), signal: controller.signal });
  await startedPromise;
  controller.abort();
  await assert.rejects(result, error => error.name === 'AbortError');
});

test('a stalled stream expires with a safe timeout error', async t => {
  const original = process.env.UPSTREAM_TIMEOUT_MS;
  process.env.UPSTREAM_TIMEOUT_MS = '100';
  try {
    const provider = await mock(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); });
    await assert.rejects(collect(options(provider)), { code: 'UPSTREAM_TIMEOUT', status: 504 });
  } finally {
    if (original === undefined) delete process.env.UPSTREAM_TIMEOUT_MS;
    else process.env.UPSTREAM_TIMEOUT_MS = original;
  }
});


for (const protocol of ['openai-chat','openai-responses','anthropic']) {
  test(protocol + ' maps explicit effort and leaves automatic requests unchanged', async t => {
    const bodies=[];
    const provider=await mock(t,(_req,res,body)=>{bodies.push(body);res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'full original reason',detail:{unexpected:'preserved'},key:'secret-test-key'}}));});
    for (const effort of ['auto','high']) await assert.rejects(collect({...options({...provider,protocol}),effort}), error=>{
      assert.ok(error.rawDiagnostic.body.includes('unexpected'));
      assert.ok(!error.rawDiagnostic.body.includes('secret-test-key'));
      assert.equal(error.rawDiagnostic.truncated,false);
      return true;
    });
    assert.equal(bodies[0].reasoning_effort,undefined);assert.equal(bodies[0].reasoning,undefined);assert.equal(bodies[0].output_config,undefined);
    assert.equal(protocol==='openai-chat'?bodies[1].reasoning_effort:protocol==='openai-responses'?bodies[1].reasoning.effort:bodies[1].output_config.effort,'high');
  });
}
