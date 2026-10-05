import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { once, EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createStore } from '../server/store.mjs';
import { createWorkService } from '../server/work.mjs';
import { runWorker } from '../runner/worker.mjs';
import { runNativeAgent } from '../runner/native-agent.mjs';
import { createBroker } from '../runner/broker.mjs';
import { DEFAULT_LIMITS } from '../runner/protocol.mjs';

const token = 't'.repeat(43), jobId = 'a'.repeat(32);
const provider = { baseUrl: 'https://provider.example.invalid/v1', protocol: 'openai-chat', apiKey: 'sk-synthetic-private-test' };
const makeJob = extra => ({ engine: 'native', protocol: 'openai-chat', model: 'test-model', mode: 'work', effort: 'auto', prompt: 'Create the requested file.', systemPrompt: '', webSearch: false, skills: [], images: [], files: [], limits: { ...DEFAULT_LIMITS }, gateway: `http://gateway:3210/proxy/${jobId}`, jobToken: token, ...extra });
function directory(t, beforeCleanup = () => {}) { const path = mkdtempSync(join(tmpdir(), 'apirouter-transport-test-')); t.after(() => { beforeCleanup(); const target = realpathSync(path); assert.ok(target.startsWith(realpathSync(tmpdir()) + sep) && target.includes('apirouter-transport-test-')); rmSync(target, { recursive: true, force: true }); }); return path; }
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
const collect = async stream => { const result = []; for await (const event of stream) result.push(event); return result; };
const sse = rows => new Response(rows.map(row => `data: ${JSON.stringify(row)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const answer = text => sse([{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }]);
function serviceFixture(t, fetcher) {
  let store, service;
  store = createStore(directory(t, () => { service?.close(); store?.close(); }));
  const stamp = new Date().toISOString();
  store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES (?,?,?,?,?,?)', 'owner', 'Owner', 'owner@example.invalid', 'unused', 'user', stamp);
  store.run('INSERT INTO chats(id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)', 'chat', 'owner', 'Work', stamp, stamp);
  store.run('INSERT INTO messages(id,chat_id,role,content,created_at) VALUES (?,?,?,?,?)', 'answer', 'chat', 'assistant', '', stamp);
  service = createWorkService({ store, runnerUrl: 'http://runner:3210', runnerToken: token, fetcher });
  return { store, service, options: { provider, model: { modelId: 'test-model' }, messages: [{ role: 'user', content: 'Create a file.' }], mode: 'work', context: { userId: 'owner', chatId: 'chat', assistantId: 'answer' } } };
}

test('HTTP 500 after completed tools keeps status, diagnostics, files and safe continuation through worker', async t => {
  const cwd = directory(t), events = [];
  let calls = 0;
  await runWorker(makeJob(), { cwd, emit: event => events.push(event), nativeRunner: (job, runtime) => runNativeAgent(job, { ...runtime, fetcher: async () => {
    if (++calls === 1) return sse([{ choices: [{ delta: { content: '文件已经准备', tool_calls: [{ index: 0, id: 'write-once', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'output/result.txt', content: 'created once' }) } }] }, finish_reason: 'tool_calls' }] }]);
    return new Response('{"error":"upstream failed"}', { status: 500, headers: { 'x-request-id': 'http-500-test' } });
  } }) });
  const error = events.find(event => event.type === 'error');
  assert.equal(error.status, 500); assert.equal(error.upstreamStatus, 500); assert.equal(error.code, 'UPSTREAM_HTTP_ERROR');
  assert.equal(error.rawDiagnostic.status, 500); assert.equal(error.rawDiagnostic.headers['x-request-id'], 'http-500-test');
  assert.match(error.rawDiagnostic.body, /upstream failed/);
  const state = events.filter(event => event.type === 'checkpoint').at(-1).state;
  assert.equal(state.journal[0].status, 'completed');
  assert.equal(state.visibleText, '文件已经准备');
  assert.ok(events.some(event => event.type === 'file' && event.file.path === 'result.txt'));
  writeFileSync(join(cwd, 'output/result.txt'), 'preserve external revision');
  let resumed;
  await runNativeAgent(makeJob({ continuation: true, resumeState: state, resumeText: state.visibleText }), { cwd, fetcher: async (_url, request) => { resumed = JSON.parse(request.body); return answer('，接续完成。'); } });
  assert.equal(readFileSync(join(cwd, 'output/result.txt'), 'utf8'), 'preserve external revision');
  assert.ok(resumed.messages.some(item => item.role === 'tool' && item.tool_call_id === 'write-once'));
  assert.match(resumed.messages.at(-1).content, /without repeating/);
});

for (const status of [400, 429, 500]) test(`native HTTP ${status} survives worker, broker and Work service without exposing credentials`, async t => {
  const cwd = directory(t); let base, workerError;
  const broker = createBroker({ token, self: 'test-broker', docker: async () => '', publicRequest: async () => ({ response: new Response(JSON.stringify({ error: { message: `rejected ${provider.apiKey}` } }), { status, headers: { 'x-request-id': `status-${status}` } }), cleanup: async () => {} }), spawnDocker: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); let input;
    child.stdin = new Writable({ write(chunk, _encoding, done) { input = JSON.parse(chunk.toString()); done(); }, final(done) {
      done(); void runWorker(input, { cwd, emit: event => { if (event.type === 'error') workerError = event; child.stdout.write(JSON.stringify(event) + '\n'); }, nativeRunner: (job, runtime) => runNativeAgent(job, { ...runtime, fetcher: (url, options) => fetch(url.replace('http://gateway:3210', base), options) }) }).then(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 0); }, error => child.emit('error', error));
    } }); return child;
  } });
  base = await listen(broker.server); t.after(() => broker.close());
  const { service, store, options } = serviceFixture(t, (url, init) => fetch(url.replace('http://runner:3210', base), init));
  await assert.rejects(collect(service.stream(options)), error => {
    assert.equal(error.code, 'UPSTREAM_HTTP_ERROR'); assert.equal(error.upstreamStatus, status);
    assert.equal(error.rawDiagnostic.source, 'upstream-http'); assert.equal(error.rawDiagnostic.status, status);
    assert.equal(error.rawDiagnostic.headers['x-request-id'], `status-${status}`);
    assert.ok(!JSON.stringify(error.rawDiagnostic).includes(provider.apiKey)); assert.ok(!JSON.stringify(error.rawDiagnostic).includes(token));
    assert.match(error.rawDiagnostic.body, /rejected/); return true;
  });
  assert.equal(workerError.status, status);
  assert.ok(store.get('SELECT assistant_id FROM work_checkpoints WHERE assistant_id=?', 'answer'));
});

test('gateway records actual network failures and never reuses an older HTTP failure for local validation', async t => {
  let mode = 'http';
  const broker = createBroker({ token, self: 'test-broker', docker: async () => '', publicRequest: async () => {
    if (mode === 'network') throw Object.assign(new Error(`connection reset ${provider.apiKey}`), { code: 'ECONNRESET' });
    if (mode === 'timeout') throw new DOMException('upstream expired', 'TimeoutError');
    return { response: new Response('{"error":"first failure"}', { status: 500 }), cleanup: async () => {} };
  } });
  const task = { id: jobId, network: `ar-work-${jobId}`, provider, config: makeJob(), jobToken: token, calls: 0, controller: new AbortController() };
  broker.jobs.set(jobId, task); const base = await listen(broker.server); t.after(() => broker.close());
  const call = model => fetch(`${base}/proxy/${jobId}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, max_completion_tokens: 100, messages: [] }) });
  await (await call('test-model')).text(); assert.equal(task.lastDiagnostic.status, 500);
  assert.equal((await call('incorrect-model')).status, 400); assert.equal(task.lastDiagnostic, null);
  for (const name of ['network', 'timeout']) {
    mode = name; await (await call('test-model')).text();
    assert.equal(task.lastDiagnostic.source, 'upstream-transport'); assert.equal(task.lastDiagnostic.status, null);
    assert.equal(task.lastDiagnostic.code, name === 'timeout' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_CONNECTION_ERROR');
    assert.ok(!task.lastDiagnostic.body.includes(provider.apiKey));
  }
});

test('same-channel automatic continuation cannot replay committed CLI or native tools without a checkpoint', async t => {
  let calls = 0;
  const { service, options } = serviceFixture(t, async () => { calls++; throw new Error('must not execute a new job'); });
  for (const runtime of ['api', 'claude-code']) {
    await assert.rejects(collect(service.stream({ ...options, provider: { ...provider, runtime, protocol: 'anthropic' }, context: { ...options.context, continuation: true, fallback: false, committedTools: true, fallbackFrom: { runtime } } })), { code: 'WORK_FALLBACK_UNSAFE' });
    await assert.rejects(collect(service.stream({ ...options, provider: { ...provider, runtime, protocol: 'anthropic' }, context: { ...options.context, assistantId: undefined, continuation: true, fallback: false, committedTools: true, fallbackFrom: { runtime } } })), { code: 'WORK_FALLBACK_UNSAFE' });
  }
  assert.equal(calls, 0);
});

test('Work preserves gateway transport diagnostics for retry decisions', async t => {
  const { service, options } = serviceFixture(t, async () => new Response([
    { type: 'error', code: 'UPSTREAM_HTTP_ERROR', error: '上游连接失败', rawDiagnostic: { source: 'upstream-transport', code: 'UPSTREAM_TIMEOUT', status: null, method: 'POST', protocol: 'openai-chat', url: provider.baseUrl + '/chat/completions', body: 'network timeout' } },
    { type: 'done' },
  ].map(event => JSON.stringify(event)).join('\n') + '\n'));
  await assert.rejects(collect(service.stream(options)), error => error.code === 'UPSTREAM_TIMEOUT' && error.upstreamStatus === undefined && error.rawDiagnostic.body === 'network timeout');
});
