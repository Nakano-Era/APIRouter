import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createStore } from '../server/store.mjs';
import { buildContext, createWorkService } from '../server/work.mjs';
import { DEFAULT_LIMITS, validateLimits, validateJob, UPSTREAM_REQUEST_TIMEOUT_MS } from '../runner/protocol.mjs';
import { runWorker } from '../runner/worker.mjs';
import { createBroker } from '../runner/broker.mjs';

const token = 'a'.repeat(43), jobId = 'c'.repeat(32);
const provider = { baseUrl: 'https://example.com/v1', protocol: 'anthropic', apiKey: 'sk-synthetic', authMode: 'bearer' };
const job = extra => ({ engine: 'native', protocol: 'anthropic', mode: 'work', model: 'test-model', effort: 'auto', prompt: 'Inspect the uploaded archive.', systemPrompt: '', webSearch: false, skills: [], files: [], images: [], limits: { ...DEFAULT_LIMITS }, gateway: `http://gateway:3210/proxy/${jobId}`, jobToken: token, ...extra });
const original = (id, name, content) => ({ path: `input/${id}/${name}`, data: Buffer.from(content).toString('base64') });
function temporary(t, beforeCleanup = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-work-input-'));
  t.after(() => { beforeCleanup(); const target = realpathSync(directory), root = realpathSync(tmpdir()); assert.ok(target.startsWith(root + sep) && target.includes('apirouter-work-input-')); rmSync(target, { recursive: true, force: true }); });
  return directory;
}
function serviceFixture(t, fetcher) {
  let service, store;
  const directory = temporary(t, () => { service?.close(); store?.close(); }); store = createStore(directory);
  const stamp = new Date().toISOString();
  store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES (?,?,?,?,?,?)', 'owner', 'Owner', 'owner@example.com', 'unused', 'user', stamp);
  store.run('INSERT INTO chats(id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)', 'chat', 'owner', 'uploads', stamp, stamp);
  service = createWorkService({ store, runnerUrl: 'http://runner:3210', runnerToken: token, fetcher });
  return { service, store };
}
const collect = async stream => { const rows = []; for await (const row of stream) rows.push(row); return rows; };
const requestOptions = extra => ({ provider, model: { modelId: 'test-model', vision: true }, messages: [{ role: 'user', content: 'inspect' }], mode: 'work', context: { userId: 'owner', chatId: 'chat' }, ...extra });
const responseEvents = events => new Response(events.map(row => JSON.stringify(row) + '\n').join(''));

test('Work context passes original bytes separately with stable unique paths and preserves archive previews', () => {
  const archive = { name: '源码.zip', kind: 'archive', text: 'Archive preview: README.md', originalFile: original('zip1', '源码.zip', Buffer.from([0x50, 0x4b, 0, 1])) };
  const messages = [{ role: 'user', content: '检查', attachments: [archive, { name: '源码.zip', kind: 'file', text: 'Second original', originalFile: original('zip2', '源码.zip', 'different bytes') }, { name: 'notes.txt', kind: 'text', text: 'visible text', originalFile: original('txt', 'notes.txt', 'original text') }, { name: 'figure.png', kind: 'image', dataUrl: 'data:image/png;base64,aGVsbG8=', originalFile: original('img', 'figure.png', 'hello') }] }, { role: 'user', content: '继续检查', attachments: [archive] }];
  const result = buildContext(messages);
  assert.equal(result.files.length, 4);
  assert.deepEqual(result.files[0], archive.originalFile);
  assert.match(result.prompt, /\/workspace\/input\/zip1\/源码.zip/);
  assert.match(result.prompt, /Archive preview: README.md/);
  assert.match(result.prompt, /workspacePath/);
  assert.ok(!result.prompt.includes(archive.originalFile.data));
  assert.equal(result.images[0].source.data, 'aGVsbG8=');
  const chat = buildContext([{ role: 'user', content: 'inspect preview', attachments: [{ name: 'notes.zip', kind: 'archive', text: 'Preview without sandbox' }, { name: 'audio.mp3', kind: 'file', text: 'Original requires Work' }] }]);
  assert.match(chat.prompt, /Preview without sandbox/); assert.match(chat.prompt, /Original requires Work/); assert.deepEqual(chat.files, []);
});

test('Work original inputs reject traversal, namespace escape, collisions, oversized data and excess totals', () => {
  for (const path of ['output/archive.zip', 'input/a/../evil', 'input/a/b/c.zip', 'input/.claude/settings.json', 'input/a\\b/x.zip', '/input/a/x.zip', 'input/a/.secret']) {
    assert.throws(() => buildContext([{ role: 'user', content: 'inspect', attachments: [{ kind: 'archive', originalFile: { path, data: '' } }] }]));
  }
  const file = original('one', 'same.zip', 'one');
  assert.throws(() => buildContext([{ role: 'user', content: 'inspect', attachments: [{ kind: 'archive', originalFile: file }, { kind: 'archive', originalFile: { ...file, data: Buffer.from('two').toString('base64') } }] }]), /冲突/);
  assert.throws(() => validateJob(job({ files: [{ path: 'settings.json', data: '' }] })), /input 或 output/);
  assert.throws(() => validateJob(job({ files: [original('one', 'bad.zip', Buffer.alloc(10 * 1024 * 1024 + 1))] })), /10 MB/);
  assert.throws(() => validateJob(job({ files: Array.from({ length: 101 }, (_, index) => original(`id${index}`, 'empty.zip', '')) })), /100 个/);
  const data = Buffer.alloc(10 * 1024 * 1024).toString('base64');
  assert.throws(() => validateJob(job({ files: Array.from({ length: 11 }, (_, index) => ({ path: `input/id${index}/ten.bin`, data })) })), /100 MB/);
  assert.throws(() => validateJob(job({ files: [{ path: 'input/id/x.zip', data: 'a' }] })), /编码/);
});

test('Work input originals do not consume output quotas and never become generated downloads', async t => {
  const cwd = temporary(t), events = [];
  const files = [original('a', 'source.zip', Buffer.from([0x50, 0x4b, 0, 1])), original('b', 'source.zip', 'second upload'), { path: 'output/prior.txt', data: Buffer.from('prior').toString('base64') }];
  await runWorker(job({ files, limits: { ...DEFAULT_LIMITS, artifactMaxFiles: 1, artifactTotalMb: 1 } }), { cwd, emit: row => events.push(row), nativeRunner: async (_job, runtime) => {
    assert.deepEqual(readFileSync(join(runtime.cwd, files[0].path)), Buffer.from([0x50, 0x4b, 0, 1]));
    assert.equal(readFileSync(join(runtime.cwd, files[1].path), 'utf8'), 'second upload');
    assert.equal(readFileSync(join(runtime.cwd, 'output/prior.txt'), 'utf8'), 'prior');
    writeFileSync(join(runtime.cwd, 'output/prior.txt'), 'processed');
  } });
  assert.deepEqual(events.filter(row => row.type === 'file').map(row => row.file.path), ['prior.txt']);
  assert.equal(events.at(-1).type, 'done');
});

test('Work service transports raw attachments and restores only saved output beside fresh inputs', async t => {
  const payloads = [], input = original('archive', 'project.7z', Buffer.from([0x37, 0x7a, 0xbc, 0xaf]));
  const { service } = serviceFixture(t, async (_url, options) => { payloads.push(JSON.parse(options.body)); return responseEvents([{ type: 'file', file: { path: 'result.txt', data: Buffer.from('extracted').toString('base64') } }, { type: 'done' }]); });
  const options = requestOptions({ messages: [{ role: 'user', content: 'inspect archive', attachments: [{ kind: 'archive', name: 'project.7z', text: '7z preview', originalFile: input }] }] });
  await collect(service.stream(options)); await collect(service.stream(options));
  assert.deepEqual(payloads[0].files, [input]);
  assert.deepEqual(payloads[1].files.map(file => file.path), [input.path, 'output/result.txt']);
  assert.ok(!payloads[0].prompt.includes(input.data));
  await assert.rejects(collect(service.stream({ ...options, mode: 'chat' })), /切换 Work/);
});

test('Work timeout 0 disables the job deadline while positive limits remain validated and applied', async t => {
  assert.equal(validateLimits({ timeoutSeconds: 0 }).timeoutSeconds, 0);
  for (const timeoutSeconds of [-1, 1, 29, 1801, NaN, Infinity, 0.5]) assert.throws(() => validateLimits({ timeoutSeconds }));
  assert.equal(validateLimits({ timeoutSeconds: 30 }).timeoutSeconds, 30);
  const durations = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => { durations.push(milliseconds); return new AbortController().signal; });
  for (const timeoutSeconds of [0, 30]) {
    const cwd = temporary(t);
    await runWorker(job({ limits: { ...DEFAULT_LIMITS, timeoutSeconds } }), { cwd, emit: () => {}, nativeRunner: async (_job, runtime) => { assert.equal(runtime.signal.aborted, false); } });
  }
  assert.deepEqual(durations, [30_000]);
});

test('unlimited Work service remains cancellable and does not create a hidden deadline', async t => {
  let ready, received;
  const reached = new Promise(resolve => { ready = resolve; });
  const durations = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => { durations.push(milliseconds); return new AbortController().signal; });
  const { service, store } = serviceFixture(t, async (_url, options) => {
    received = options.signal; ready();
    return await new Promise((_, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); });
  });
  store.run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'workSettings', JSON.stringify({ timeoutSeconds: 0 }));
  const controller = new AbortController();
  const result = collect(service.stream(requestOptions({ signal: controller.signal })));
  await reached; assert.equal(received.aborted, false); assert.deepEqual(durations, []);
  controller.abort(new Error('user stopped'));
  await assert.rejects(result, /user stopped/); assert.equal(received.aborted, true);
});

test('unlimited broker jobs continue until completion and upstream calls retain a separate finite timeout', async t => {
  let workerInput, upstreamTimeout;
  const broker = createBroker({ token, self: 'broker', docker: async () => '', publicRequest: async (_url, options) => { upstreamTimeout = options.timeoutMs; return { response: new Response('{}'), cleanup: async () => {} }; }, spawnDocker: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let text = '';
    child.stdin = new Writable({ write(chunk, _encoding, callback) { text += chunk; callback(); }, final(callback) { workerInput = JSON.parse(text); callback(); setTimeout(() => { child.stdout.end(JSON.stringify({ type: 'delta', text: 'completed without deadline' }) + '\n' + JSON.stringify({ type: 'done' }) + '\n'); child.stderr.end(); child.emit('close', 0); }, 25); } });
    return child;
  } });
  broker.server.listen(0, '127.0.0.1'); await once(broker.server, 'listening'); t.after(() => broker.close());
  const base = `http://127.0.0.1:${broker.server.address().port}`;
  const response = await fetch(base + '/jobs', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...job({ limits: { ...DEFAULT_LIMITS, timeoutSeconds: 0 } }), provider }) });
  const output = await response.text(); assert.match(output, /completed without deadline/); assert.ok(!output.includes('WORK_TIMEOUT')); assert.equal(workerInput.limits.timeoutSeconds, 0);
  const task = { id: jobId, network: `ar-work-${jobId}`, config: job({ limits: { ...DEFAULT_LIMITS, timeoutSeconds: 0 } }), provider, jobToken: 'z'.repeat(43), controller: new AbortController(), calls: 0 };
  broker.jobs.set(jobId, task);
  const upstream = await fetch(`${base}/proxy/${jobId}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${task.jobToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'test-model', max_tokens: 100, messages: [] }) });
  assert.equal(upstream.status, 200); await upstream.text(); assert.equal(upstreamTimeout, UPSTREAM_REQUEST_TIMEOUT_MS); assert.ok(upstreamTimeout > 0);
});

test('a silent unlimited task receives transport heartbeats without inventing model activity', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let child, ready;
  const started = new Promise(resolve => { ready = resolve; });
  const broker = createBroker({ token, self: 'broker', docker: async () => '', spawnDocker: () => {
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); }, final(callback) { callback(); ready(); } });
    return child;
  } });
  broker.server.listen(0, '127.0.0.1'); await once(broker.server, 'listening'); t.after(() => broker.close());
  const request = fetch(`http://127.0.0.1:${broker.server.address().port}/jobs`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...job({ limits: { ...DEFAULT_LIMITS, timeoutSeconds: 0 } }), provider }) });
  await started;
  const response = await request, reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /正在启动隔离工作区/);
  t.mock.timers.tick(15_000);
  assert.equal(new TextDecoder().decode((await reader.read()).value), '\n');
  child.stdout.end('{"type":"done"}\n'); child.stderr.end(); child.emit('close', 0);
  let rest = ''; for (;;) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); }
  assert.equal(rest, '{"type":"done"}\n');
});
