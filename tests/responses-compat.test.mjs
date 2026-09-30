import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { prepareResponsesRequest, responsesProfile, responseRequestShape } from '../server/responses-compat.mjs';
import { streamReply } from '../server/upstream.mjs';

const input = () => ({ model: 'test-model', input: [{ role: 'user', content: [{ type: 'input_text', text: 'private prompt' }] }, { role: 'assistant', content: [{ type: 'output_text', text: 'saved prefix' }] }], max_output_tokens: 4096, instructions: 'Custom instructions', stream: true, store: false });
test('Codex profile is scoped to Responses, exact host or explicit selection', () => {
  for (const baseUrl of ['https://anyrouter.top/v1', 'https://api.anyrouter.top/v1']) assert.equal(responsesProfile({ baseUrl, protocol: 'openai-responses' }), 'codex');
  for (const baseUrl of ['https://anyrouter.top.evil.example', 'https://example.com']) assert.equal(responsesProfile({ baseUrl, protocol: 'openai-responses' }), 'standard');
  assert.equal(responsesProfile({ baseUrl: 'https://anyrouter.top', protocol: 'openai-responses', responsesProfile: 'standard' }), 'standard');
  assert.equal(responsesProfile({ baseUrl: 'https://anyrouter.top', protocol: 'anthropic', responsesProfile: 'codex' }), 'standard');
});

test('compatibility retains history, instructions and real tools; standard payload is unchanged', () => {
  const body = { ...input(), tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }], reasoning: { effort: 'high' } };
  const standard = prepareResponsesRequest({ protocol: 'openai-responses', baseUrl: 'https://example.com' }, body);
  assert.equal(standard.body, body); assert.deepEqual(standard.headers, {});
  const provider = { protocol: 'openai-responses', responsesProfile: 'codex' };
  const compatible = prepareResponsesRequest(provider, body, { sessionId: 'private-chat-id' });
  assert.equal(compatible.body.max_output_tokens, undefined); assert.equal(body.max_output_tokens, 4096);
  assert.equal(compatible.body.instructions, body.instructions); assert.deepEqual(compatible.body.tools, body.tools);
  assert.equal(compatible.body.input[0].type, 'message'); assert.equal(compatible.body.input[1].content[0].type, 'output_text');
  const native = prepareResponsesRequest(provider, { ...body, input: [{ role: 'user', content: 'native Work task' }, { type: 'function_call_output', call_id: 'call-1', output: 'done' }] });
  assert.deepEqual(native.body.input[0].content, [{ type: 'input_text', text: 'native Work task' }]);
  assert.equal(native.body.input[1].type, 'function_call_output');
  assert.equal(compatible.body.store, false); assert.equal(compatible.body.stream, true);
  assert.deepEqual(compatible.body.include, ['reasoning.encrypted_content']);
  assert.equal(compatible.body.reasoning.effort, 'high');
  assert.equal(compatible.headers['session-id'], prepareResponsesRequest(provider, body, { sessionId: 'private-chat-id' }).headers['session-id']);
  const diagnostic = JSON.stringify(responseRequestShape(compatible.body, compatible.profile));
  assert.ok(!diagnostic.includes('private prompt')); assert.ok(!JSON.stringify(compatible.headers).includes('private-chat-id'));
});

test('ordinary chat and model tests send the compatible body and retain actionable raw errors', async t => {
  const old = process.env.ALLOW_PRIVATE_UPSTREAM; process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  let calls = 0;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); calls++;
    assert.equal(req.url, '/v1/responses'); assert.equal(req.headers.authorization, 'Bearer test-key');
    assert.match(req.headers['user-agent'], /APIRouter compatibility/);
    assert.equal(body.max_output_tokens, undefined); assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    assert.ok(body.instructions);
    if (calls === 1) { res.setHeader('content-type', 'text/event-stream'); res.end('data: '+JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] } })+'\n\n'); }
    else { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'invalid codex request', code: 'invalid_responses_request' } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (old === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM; else process.env.ALLOW_PRIVATE_UPSTREAM = old; });
  const args = { provider: { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-key', protocol: 'openai-responses', responsesProfile: 'codex' }, model: { modelId: 'test-model' }, messages: [{ role: 'user', content: 'private prompt' }], maxOutputTokens: 500, diagnostics: true };
  const events = []; for await (const event of streamReply(args)) events.push(event);
  assert.equal(events.find(event => event.type === 'delta').text, 'ok');
  await assert.rejects(async () => { for await (const _ of streamReply(args)) {} }, error => {
    assert.match(error.rawDiagnostic.body, /invalid codex request/); assert.equal(error.rawDiagnostic.requestShape.responsesProfile, 'codex');
    assert.match(error.adminDiagnostic.note, /令牌/); assert.ok(!JSON.stringify(error.rawDiagnostic).includes('private prompt')); return true;
  });
});

test('Responses failure terminal events retain final partial text and known usage', async t => {
  const old = process.env.ALLOW_PRIVATE_UPSTREAM; process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.end('data: '+JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { message: 'disconnected' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'saved partial output' }] }], usage: { input_tokens: 12, output_tokens: 4 } } })+'\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (old === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM; else process.env.ALLOW_PRIVATE_UPSTREAM = old; });
  const events = [];
  await assert.rejects(async () => { for await (const event of streamReply({ provider: { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-key', protocol: 'openai-responses' }, model: { modelId: 'test-model' }, messages: [{ role: 'user', content: 'hello' }] })) events.push(event); }, { code: 'UPSTREAM_STREAM_ERROR' });
  assert.equal(events[0].text, 'saved partial output');
  assert.equal(events.find(event => event.type === 'usage').outputTokens, 4);
});
