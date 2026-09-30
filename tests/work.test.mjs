import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import express from 'express';
import { createStore } from '../server/store.mjs';
import { createWorkService, buildContext } from '../server/work.mjs';
import { createRouter } from '../server/router.mjs';
import { DEFAULT_LIMITS, validateLimits, validateSkill, skillMetadata, validateJob, safeRelativePath, dockerArguments, claudeArguments, parseClaudeEvent } from '../runner/protocol.mjs';
import { collectArtifacts, runWorker } from '../runner/worker.mjs';
import { createBroker, gatewayEndpoint, gatewayHeaders } from '../runner/broker.mjs';
import { safePublicRequest } from '../runner/network.mjs';

const provider = { baseUrl: 'https://example.com/v1', protocol: 'anthropic', apiKey: 'sk-test-secret-never-worker', authMode: 'bearer' };
const token = 'a'.repeat(43);
const jobId = 'c'.repeat(32);
const job = extra => ({ engine: 'native', protocol: 'anthropic', mode: 'work', model: 'claude-test', effort: 'high', prompt: '创建文件，回答中文', systemPrompt: '', webSearch: false, skills: [], files: [], images: [], limits: { ...DEFAULT_LIMITS }, ...extra });
function temp(t, beforeCleanup = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-work-test-'));
  t.after(() => { beforeCleanup(); const target = realpathSync(directory), root = realpathSync(tmpdir()); assert.ok(target.startsWith(root + sep) && target.includes('apirouter-work-test-')); rmSync(target, { recursive: true, force: true }); });
  return directory;
}
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
function fixture(t, options = {}) {
  let service, store;
  const directory = temp(t, () => { service?.close(); store?.close(); }); store = createStore(directory);
  const stamp = new Date().toISOString();
  for (const name of ['owner', 'other', 'admin']) store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES (?,?,?,?,?,?)', name, name, `${name}@example.com`, 'unused', name === 'admin' ? 'admin' : 'user', stamp);
  store.run('INSERT INTO chats(id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)', 'chat', 'owner', 'work', stamp, stamp);
  service = createWorkService({ store, dataDir: directory, runnerUrl: 'http://runner:3210', runnerToken: token, ...options });
  return { directory, store, service };
}
const eventsResponse = events => new Response(events.map(event => JSON.stringify(event) + '\n').join(''), { headers: { 'content-type': 'application/x-ndjson' } });
const options = extra => ({ provider, model: { modelId: 'claude-test', vision: true }, messages: [{ role: 'user', content: '创建文件' }], mode: 'work', effort: 'high', context: { userId: 'owner', chatId: 'chat' }, ...extra });
async function collect(stream) { const output = []; for await (const event of stream) output.push(event); return output; }

test('work resource limits reject arbitrary mounts, shell flags and unbounded values', () => {
  for (const value of [{ memoryMb: 128 }, { cpus: 20 }, { enabled: 1 }, { timeoutSeconds: Infinity }, { maxTurns: 1.5 }, { hostPath: '/' }]) assert.throws(() => validateLimits(value));
  assert.equal(validateLimits({ cpus: 0.25 }).cpus, 0.25);
  const args = dockerArguments({ id: jobId, network: `ar-work-${jobId}`, image: 'apirouter-work:local', limits: DEFAULT_LIMITS });
  assert.ok(args.includes('--read-only')); assert.ok(args.includes('1000:1000')); assert.ok(args.includes('no-new-privileges:true'));
  assert.ok(!args.some(arg => arg.includes('docker.sock') || arg === '--privileged' || arg === '--volume' || arg === '--mount'));
  assert.throws(() => dockerArguments({ id: jobId, network: 'host', image: 'image', limits: DEFAULT_LIMITS }));
  assert.throws(() => dockerArguments({ id: '../bad', network: `ar-work-${jobId}`, image: 'image', limits: DEFAULT_LIMITS }));
});

test('work Claude flags select real tools; Chat disables tools; effort auto omitted', () => {
  const args = claudeArguments(job());
  assert.ok(args.includes('--include-partial-messages')); assert.ok(args.includes('--strict-mcp-config'));
  assert.match(args[args.indexOf('--tools') + 1], /Agent,Skill,Read,Write,Edit,Bash/);
  assert.ok(!args[args.indexOf('--tools') + 1].includes('WebSearch'));
  const web = claudeArguments(job({ webSearch: true })); assert.match(web[web.indexOf('--tools') + 1], /WebSearch/);
  const chat = claudeArguments(job({ mode: 'chat', effort: 'auto' }));
  assert.equal(chat[chat.indexOf('--tools') + 1], ''); assert.ok(chat.includes('--disable-slash-commands')); assert.ok(!chat.includes('--effort'));
});

test('work safe paths, skills and inputs reject traversal, hooks metadata and large payloads', () => {
  for (const path of ['../x', '/etc/passwd', 'a\\b', '.claude/settings.json', 'a/../b', 'C:/file', 'a//b', 'a/.secret']) assert.throws(() => safeRelativePath(path));
  assert.equal(safeRelativePath('报告/图形.svg'), '报告/图形.svg');
  const content = '---\nname: drawing\ndescription: "画图"\nhooks: bad\n---\n请创建 SVG';
  assert.deepEqual(skillMetadata(content), { name: 'drawing', description: '画图' });
  const skill = validateSkill({ name: 'drawing', description: '画图', content });
  assert.ok(!skill.content.includes('hooks:')); assert.match(skill.content, /请创建 SVG/);
  assert.throws(() => validateSkill({ ...skill, content: '!`rm x`' }));
  assert.throws(() => validateJob(job({ model: '--dangerously-skip-permissions' })));
  assert.throws(() => validateJob(job({ images: [{ type: 'image', source: { type: 'url', url: 'http://internal' } }] })));
});

test('work context preserves transcript roles and true image content', () => {
  const data = buildContext([{ role: 'assistant', content: '前一个回答' }, { role: 'user', content: '看图', attachments: [{ name: '图.png', kind: 'image', dataUrl: 'data:image/png;base64,aGVsbG8=' }] }]);
  assert.match(data.prompt, /"role":"assistant"/); assert.equal(data.images[0].source.data, 'aGVsbG8=');
  assert.throws(() => buildContext([{ role: 'system', content: 'bad' }]));
});

test('work parser avoids duplicate text and marks tool calls committed', () => {
  const state = { tools: new Set(), streamed: false, finished: false };
  const tool = { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Write', id: 'w1' } } };
  assert.equal(parseClaudeEvent(tool, state)[0].committed, true);
  assert.equal(parseClaudeEvent(tool, state).length, 0);
  assert.equal(parseClaudeEvent({ type: 'stream_event', event: { delta: { type: 'text_delta', text: '回答' } } }, state)[0].text, '回答');
  const result = parseClaudeEvent({ type: 'result', subtype: 'success', result: '回答', usage: { input_tokens: 4, cache_read_input_tokens: 2, output_tokens: 3 } }, state);
  assert.deepEqual(result, [{ type: 'usage', inputTokens: 6, outputTokens: 3 }]);
  assert.equal(parseClaudeEvent({ type: 'result', subtype: 'error_max_turns', is_error: true }, state)[0].type, 'error');
});

test('Claude thinking stream and assistant snapshots emit folded reasoning once, excluding signatures', () => {
  const state = { tools: new Set(), streamed: false, finished: false }, events = [];
  for (const row of [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '先' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '检查。' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'hidden-signature' } } },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: '先检查。', signature: 'hidden-signature' }] } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '结果正文。' } } },
    { type: 'result', subtype: 'success', result: '结果正文。' },
  ]) events.push(...parseClaudeEvent(row, state));
  assert.equal(events.filter(event => event.type === 'reasoning').map(event => event.text).join(''), '先检查。');
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), '结果正文。');
  assert.ok(!JSON.stringify(events).includes('hidden-signature'));
  assert.deepEqual(parseClaudeEvent({ type: 'assistant', message: { id: 'm2', content: [{ type: 'thinking', thinking: '仅完整消息。', signature: 'sig' }] } }, state), [{ type: 'reasoning', text: '仅完整消息。' }]);
});

test('Claude redacted block suppresses mixed deltas without suppressing the next message same index', () => {
  const state = { tools: new Set(), streamed: false, finished: false }, events = [];
  for (const row of [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'redacted-message' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'encrypted' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'never-render-thinking' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'never-render-text' } } },
    { type: 'assistant', message: { id: 'redacted-message', content: [{ type: 'thinking', thinking: 'never-render-snapshot' }] } },
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'normal-message' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Visible thinking.' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Visible answer.' } } },
  ]) events.push(...parseClaudeEvent(row, state));
  assert.deepEqual(events, [{ type: 'reasoning', text: 'Visible thinking.' }, { type: 'delta', text: 'Visible answer.' }]);
});

test('work exports only bounded regular files, excludes links and hidden metadata', async t => {
  const directory = temp(t), output = join(directory, 'output'); mkdirSync(output);
  writeFileSync(join(output, 'a.svg'), '<svg/>'); writeFileSync(join(output, '.secret'), 'private'); writeFileSync(join(output, 'huge.bin'), 'x'.repeat(40));
  const files = await collectArtifacts(output, { bytes: 20 }); assert.deepEqual(files.map(file => file.path), ['a.svg']);
  const external = join(directory, 'external'); mkdirSync(external); writeFileSync(join(external, 'secret.txt'), 'not output');
  symlinkSync(external, join(output, 'outside'), 'junction');
  assert.deepEqual((await collectArtifacts(output, { bytes: 20 })).map(file => file.path), ['a.svg']);
  const linked = join(directory, 'linked'); symlinkSync(external, linked, 'junction'); assert.deepEqual(await collectArtifacts(linked), []);
});

test('work worker uses only short-lived gateway token and decodes split Chinese UTF-8', async t => {
  const directory = temp(t), events = []; let captured;
  const spawnProcess = (command, args, spawnOptions) => {
    captured = { command, args, spawnOptions };
    const child = new EventEmitter(); child.pid = 99999999; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); }, final(callback) { callback(); queueMicrotask(() => {
      const text = Buffer.from(JSON.stringify({ type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: '独立思考' } } }) + '\n' + JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: '中文测试' } } }) + '\n');
      for (const byte of text) child.stdout.write(Buffer.from([byte]));
      child.stdout.end(JSON.stringify({ type: 'result', subtype: 'success', result: '中文测试' }) + '\n'); child.stderr.end(); child.emit('close', 0, null);
    }); } }); return child;
  };
  await runWorker({ ...job({ engine: 'claude-code', mode: 'chat' }), gateway: `http://gateway:3210/proxy/${jobId}`, jobToken: token, provider }, { cwd: directory, spawnProcess, emit: event => events.push(event) });
  assert.equal(events.find(event => event.type === 'delta').text, '中文测试');
  assert.equal(events.find(event => event.type === 'reasoning').text, '独立思考');
  assert.equal(captured.command, 'claude'); assert.equal(captured.spawnOptions.env.ANTHROPIC_AUTH_TOKEN, token);
  assert.ok(!JSON.stringify(captured).includes(provider.apiKey)); assert.ok(events.some(event => event.type === 'done'));
});

test('work gateway restricts endpoints and replaces job credentials with configured authentication', async () => {
  assert.equal(gatewayEndpoint(`/proxy/${jobId}/v1/messages`, jobId), 'messages');
  assert.equal(gatewayEndpoint(`/proxy/${jobId}/v1/messages/count_tokens`, jobId), 'messages/count_tokens');
  assert.equal(gatewayEndpoint(`/proxy/${jobId}/v1/models`, jobId), null);
  const headers = gatewayHeaders({ authorization: 'Bearer job-key', cookie: 'secret', 'anthropic-beta': 'fine', 'x-app': 'cli', 'x-stainless-lang': 'js' }, provider);
  assert.equal(headers.authorization, `Bearer ${provider.apiKey}`); assert.equal(headers.cookie, undefined); assert.equal(headers['anthropic-beta'], 'fine');
  assert.equal(gatewayHeaders({}, { ...provider, authMode: 'auto' })['x-api-key'], provider.apiKey);
  await assert.rejects(safePublicRequest('https://127.0.0.1/private'), /拒绝/);
  await assert.rejects(safePublicRequest('http://example.com/SKILL.md'), /HTTPS/);
});

test('work service unavailable by default and rejects incompatible protocols before execution', async t => {
  const { service } = fixture(t, { runnerUrl: null, runnerToken: null });
  assert.equal(service.isConfigured(), false); assert.equal((await service.capabilities()).available, false);
  await assert.rejects(collect(service.stream(options())), error => error.code === 'WORK_NOT_CONFIGURED');
  const configured = fixture(t, { fetcher: () => { throw new Error('Must not request'); } }).service;
  await assert.rejects(collect(configured.stream(options({ provider: { ...provider, runtime: 'claude-code', protocol: 'openai-chat' } }))), error => error.code === 'WORK_PROTOCOL_UNSUPPORTED');
  await assert.rejects(collect(configured.stream(options({ context: { userId: 'other', chatId: 'chat' } }))), /无权/);
});

test('work service persists real files, rehydrates workspace, handles partial failure and diagnostic credentials', async t => {
  let payload;
  const { service, store } = fixture(t, { fetcher: async (_url, request) => {
    payload = JSON.parse(request.body);
    return eventsResponse([{ type: 'activity', label: '正在写入文件', committed: true }, { type: 'file', file: { path: 'report.svg', data: Buffer.from('<svg>中文</svg>').toString('base64') } }, { type: 'done' }]);
  } });
  const events = await collect(service.stream(options()));
  assert.equal(events[1].artifact.name, 'report.svg'); assert.equal(events[1].committed, true);
  const saved = store.get('SELECT * FROM work_artifacts'); assert.equal(Buffer.from(saved.body).toString(), '<svg>中文</svg>');
  await collect(service.stream(options())); assert.equal(payload.files[0].path, 'output/report.svg');
  const failing = fixture(t, { fetcher: async () => eventsResponse([{ type: 'error', error: '执行失败', rawDiagnostic: { status: 400, body: `Error "Bearer ${provider.apiKey}" retained \\ detail`, headers: { authorization: 'secret' } } }, { type: 'file', file: { path: 'partial.txt', data: Buffer.from('partial').toString('base64') } }, { type: 'done' }]) });
  const partialEvents = [];
  await assert.rejects(async () => { for await (const event of failing.service.stream(options())) partialEvents.push(event); }, error => { assert.equal(error.rawDiagnostic.status, 400); assert.ok(!error.rawDiagnostic.body.includes(provider.apiKey)); assert.equal(error.rawDiagnostic.headers.authorization, '[REDACTED]'); return true; });
  assert.equal(partialEvents[0].artifact.name, 'partial.txt');
});

test('work service forwards reasoning separately from final answer text', async t => {
  const { service } = fixture(t, { fetcher: async () => eventsResponse([{ type: 'reasoning', text: '任务进展思考。' }, { type: 'delta', text: '最终回答。' }, { type: 'done' }]) });
  const events = await collect(service.stream(options()));
  assert.deepEqual(events.filter(event => event.type === 'reasoning'), [{ type: 'reasoning', text: '任务进展思考。' }]);
  assert.deepEqual(events.filter(event => event.type === 'delta'), [{ type: 'delta', text: '最终回答。' }]);
});

for (const scenario of [
  { name: 'actual HTTP 503 switches before tools or text', status: 503, source: 'upstream-http', expectedCalls: ['primary', 'backup'], fails: false, channelFailures: 1 },
  { name: 'actual HTTP 400 does not retry another paid channel', status: 400, source: 'upstream-http', expectedCalls: ['primary'], fails: true, channelFailures: 0 },
  { name: 'local CLI error with a status number is not a channel outage', status: 503, source: 'claude-code', expectedCalls: ['primary'], fails: true, channelFailures: 0 },
  { name: 'actual HTTP 503 after a tool starts never switches', status: 503, source: 'upstream-http', committed: true, expectedCalls: ['primary'], fails: true, channelFailures: 1 },
]) test(`work service/router integration: ${scenario.name}`, async t => {
  const calls = [];
  const { service, store } = fixture(t, { fetcher: async (_url, request) => {
    const payload = JSON.parse(request.body), name = payload.provider.baseUrl.includes('primary') ? 'primary' : 'backup'; calls.push(name);
    if (name === 'backup') return eventsResponse([{ type: 'delta', text: '备用渠道实际回答' }, { type: 'done' }]);
    return eventsResponse([...(scenario.committed ? [{ type: 'activity', label: '正在写入文件', committed: true }] : []),
      { type: 'error', code: 'CLAUDE_EXECUTION_FAILED', error: 'CLI 请求失败', rawDiagnostic: { source: scenario.source, status: scenario.status, method: 'POST', url: 'https://primary.example.com/v1/messages', protocol: 'anthropic', body: '{"error":"upstream rejected"}' } }, { type: 'done' }]);
  } });
  for (const [index, name] of ['primary', 'backup'].entries()) {
    store.run('INSERT INTO providers(id,name,base_url,protocol,encrypted_key,key_hint,priority,runtime,created_at) VALUES (?,?,?,?,?,?,?,?,?)', name, name, `https://${name}.example.com/v1`, 'anthropic', store.encrypt(provider.apiKey), 'hint', index === 0 ? 10 : 0, 'claude-code', new Date().toISOString());
    store.run('INSERT INTO models(id,provider_id,model_id,name,route_key,reasoning_efforts) VALUES (?,?,?,?,?,?)', name, name, 'claude-test', 'Claude', 'shared', '["high"]');
  }
  const router = createRouter({ store, stream: args => service.stream(args) });
  const run = router.run({ routeKey: 'shared', messages: [{ role: 'user', content: '回答' }], mode: 'work', effort: 'high', retriesPerChannel: 0, context: { userId: 'owner', chatId: 'chat' }, requestId: 'routing-work-test' });
  if (scenario.fails) await assert.rejects(collect(run), error => { assert.equal(error.code, scenario.source === 'upstream-http' ? 'UPSTREAM_HTTP_ERROR' : 'CLAUDE_EXECUTION_FAILED'); return true; });
  else assert.ok((await collect(run)).some(event => event.text === '备用渠道实际回答'));
  assert.deepEqual(calls, scenario.expectedCalls);
  assert.equal(store.get('SELECT failure_count FROM models WHERE id=?', 'primary').failure_count, scenario.channelFailures);
});

test('work routes enforce admin skill edits and owner-only attachment downloads', async t => {
  const { service } = fixture(t, { fetcher: async () => eventsResponse([{ type: 'file', file: { path: 'page.html', data: Buffer.from('<script>alert(1)</script>').toString('base64') } }, { type: 'done' }]) });
  const artifact = (await collect(service.stream(options())))[0].artifact;
  const app = express(); app.use(express.json());
  const auth = (req, res, next) => { const name = req.get('x-test-user'); if (!['owner', 'other', 'admin'].includes(name)) return res.sendStatus(401); req.user = { id: name, role: name === 'admin' ? 'admin' : 'user' }; next(); };
  const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.sendStatus(403);
  const csrf = (_req, _res, next) => next(); service.registerRoutes(app, { auth, admin, csrf });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = createServer(app), base = await listen(server); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = (path, user = 'owner', init = {}) => fetch(base + path, { ...init, headers: { 'x-test-user': user, 'content-type': 'application/json', ...init.headers } });
  assert.equal((await request('/api/work/chats/chat/artifacts', 'other')).status, 404);
  assert.equal((await request(artifact.downloadUrl, 'other')).status, 404);
  const download = await request(artifact.downloadUrl); assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /^attachment/); assert.match(download.headers.get('content-security-policy'), /sandbox/);
  const data = { name: 'drawing', description: '画图', content: '生成 SVG' };
  assert.equal((await request('/api/work/skills', 'owner', { method: 'POST', body: JSON.stringify(data) })).status, 403);
  const skill = await (await request('/api/work/skills', 'admin', { method: 'POST', body: JSON.stringify(data) })).json();
  assert.equal((await request(`/api/work/skills/${skill.skill.id}/download`, 'owner')).status, 200);
  assert.equal((await request('/api/admin/work/settings', 'owner')).status, 403);
  assert.equal((await request('/api/admin/work/settings', 'admin', { method: 'PATCH', body: JSON.stringify({ memoryMb: 10 }) })).status, 400);
});

test('work broker never exposes master runner token or API key to worker stdin and cleans Docker objects', async t => {
  const commands = []; let workerInput;
  const broker = createBroker({ token, self: 'broker-container', docker: async args => { commands.push(args); return ''; }, spawnDocker: args => {
    commands.push(args); const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _enc, callback) { workerInput = JSON.parse(chunk.toString()); callback(); }, final(callback) { callback(); queueMicrotask(() => { child.stdout.end(JSON.stringify({ type: 'reasoning', text: `工作推理 ${provider.apiKey} ${workerInput.jobToken}` }) + '\n' + JSON.stringify({ type: 'delta', text: '工作完成' }) + '\n' + JSON.stringify({ type: 'done' }) + '\n'); child.stderr.end(); child.emit('close', 0); }); } }); return child;
  } });
  const base = await listen(broker.server); t.after(() => broker.close());
  assert.equal((await fetch(base + '/health')).status, 401);
  const response = await fetch(base + '/jobs', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...job(), provider }) });
  const output = await response.text(); assert.match(output, /工作完成/);
  const reasoning = output.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(event => event.type === 'reasoning');
  assert.match(reasoning.text, /工作推理/); assert.ok(!reasoning.text.includes(provider.apiKey)); assert.ok(!reasoning.text.includes(workerInput.jobToken));
  assert.equal(workerInput.responsesProfile, 'standard');
  assert.ok(!JSON.stringify(workerInput).includes(provider.apiKey)); assert.notEqual(workerInput.jobToken, token); assert.equal(workerInput.provider, undefined);
  assert.ok(commands.some(args => args[0] === 'network' && args[1] === 'create' && args.includes('--internal')));
  assert.ok(commands.some(args => args[0] === 'rm')); assert.ok(commands.some(args => args[0] === 'network' && args[1] === 'rm'));
  assert.equal(broker.jobs.size, 0);
});

test('work broker cleans a container even when cancellation happens during creation', async t => {
  const commands = []; let releaseCreate, created;
  const reachedCreate = new Promise(resolve => { created = resolve; });
  const broker = createBroker({ token, self: 'broker', docker: async args => { commands.push(args); if (args[0] === 'create') { created(); await new Promise(resolve => { releaseCreate = resolve; }); } return ''; }, spawnDocker: () => { throw new Error('Canceled job must never start'); } });
  const base = await listen(broker.server); t.after(() => broker.close());
  const abort = new AbortController();
  const responsePromise = fetch(base + '/jobs', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...job(), provider }), signal: abort.signal });
  await reachedCreate; const response = await responsePromise; const consume = response.text().catch(() => {}); abort.abort();
  await new Promise(resolve => setTimeout(resolve, 30)); releaseCreate(); await consume;
  for (let attempt = 0; attempt < 30 && broker.jobs.size; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(broker.jobs.size, 0);
  const rmCommands = commands.filter(args => args[0] === 'rm'); assert.ok(rmCommands.length >= 2, 'cleanup retries container removal after Docker create settles');
});

test('work gateway verifies per-job authorization and captures actual HTTP error body without credentials', async t => {
  let request;
  const broker = createBroker({ token, self: 'broker', docker: async () => '', publicRequest: async (url, options) => {
    request = { url, options };
    return { response: new Response(JSON.stringify({ error: { message: 'provider rejected parameter', echoedKey: provider.apiKey } }), { status: 400, headers: { 'content-type': 'application/json', 'request-id': 'test-request' } }), cleanup: async () => {} };
  } });
  const task = { id: jobId, network: `ar-work-${jobId}`, config: job(), provider, jobToken: 'z'.repeat(43), controller: new AbortController(), calls: 0 };
  broker.jobs.set(jobId, task);
  const base = await listen(broker.server); t.after(() => broker.close());
  const call = (body, credential = task.jobToken, path = 'messages') => fetch(`${base}/proxy/${jobId}/v1/${path}`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', 'anthropic-beta': 'test-beta', cookie: 'not-forwarded' }, body: JSON.stringify(body) });
  assert.equal((await call({ model: 'claude-test', max_tokens: 100 }, 'wrong-token')).status, 401);
  assert.equal((await call({ model: 'other-model', max_tokens: 100 })).status, 400);
  assert.equal((await call({ model: 'claude-test', max_tokens: 100 }, task.jobToken, 'models')).status, 403);
  assert.equal((await call({ model: 'claude-test', max_tokens: 100, tools: [{ type: 'web_search_20250305' }] })).status, 403);
  const response = await call({ model: 'claude-test', max_tokens: 100, messages: [] });
  assert.equal(response.status, 400); const raw = await response.text(); assert.match(raw, /provider rejected parameter/); assert.ok(!raw.includes(provider.apiKey));
  assert.equal(request.url, 'https://example.com/v1/messages'); assert.equal(request.options.headers.authorization, `Bearer ${provider.apiKey}`); assert.equal(request.options.headers.cookie, undefined);
  assert.equal(task.lastDiagnostic.status, 400); assert.equal(task.lastDiagnostic.headers['request-id'], 'test-request'); assert.equal(task.lastDiagnostic.body, raw);
});

test('work deployment files keep socket out of app and preserve compose override across upgrades', () => {
  const compose = readFileSync(new URL('../compose.work.yaml', import.meta.url), 'utf8');
  const appBlock = compose.split('  work-runner:')[0]; assert.ok(!appBlock.includes('docker.sock'));
  assert.ok(!/^\s+ports:/m.test(compose)); assert.match(compose, /internal: true/);
  const deploy = readFileSync(new URL('../deploy/work-enable.sh', import.meta.url), 'utf8');
  assert.match(deploy, /COMPOSE_FILE=compose.yaml:compose.work.yaml/); assert.ok(!/source\s+\.env/.test(deploy));
  const dockerfile = readFileSync(new URL('../runner/Dockerfile', import.meta.url), 'utf8');
  assert.ok(!dockerfile.split('FROM worker AS claude-worker')[0].includes('@anthropic-ai/claude-code'));
  assert.match(deploy, /--with-claude-code/);
});

test('native Work supports each API protocol and passes model context budgets without Claude Code', async t => {
  const calls = [];
  const { service } = fixture(t, { fetcher: async (_url, request) => { calls.push(JSON.parse(request.body)); return eventsResponse([{ type: 'delta', text: '实际回答' }, { type: 'done' }]); } });
  for (const protocol of ['anthropic', 'openai-chat', 'openai-responses']) {
    const result = await collect(service.stream(options({ provider: { ...provider, protocol, runtime: 'api' }, model: { modelId: 'any-provider-model', contextWindow: 1_000_000, maxOutputTokens: 65000 }, maxOutputTokens: 32000 })));
    assert.equal(result[0].text, '实际回答');
    assert.equal(calls.at(-1).engine, 'native'); assert.equal(calls.at(-1).protocol, protocol);
    assert.equal(calls.at(-1).contextWindow, 1_000_000); assert.equal(calls.at(-1).maxOutputTokens, 32000);
  }
  assert.doesNotThrow(() => validateJob(job({ prompt: 'a'.repeat(2 * 1024 * 1024), maxOutputTokens: 100000 })));
});

test('native worker saves actual files before a completed-tool checkpoint and does not invoke CLI', async t => {
  const directory = temp(t), events = [];
  const state = { version: 1, model: 'claude-test', protocol: 'anthropic', history: [], journal: [{ id: 'one', status: 'completed' }], pendingCalls: [], visibleText: '', partial: null, completed: false };
  await runWorker({ ...job(), gateway: `http://gateway:3210/proxy/${jobId}`, jobToken: token }, { cwd: directory, spawnProcess: () => { throw new Error('CLI must not run'); }, emit: event => events.push(event), nativeRunner: async (_job, runtime) => {
    writeFileSync(join(runtime.cwd, 'output', 'report.txt'), '已实际创建');
    await runtime.emit({ type: 'checkpoint', state });
    await runtime.emit({ type: 'checkpoint', state });
    return { completed: true, state };
  } });
  assert.deepEqual(events.map(event => event.type), ['file', 'checkpoint', 'checkpoint', 'done']);
  assert.equal(Buffer.from(events[0].file.data, 'base64').toString(), '已实际创建');
});

test('native Work checkpoints are encrypted, survive service restarts, enforce ownership, and bind model/protocol', async t => {
  const state = { version: 1, model: 'claude-test', protocol: 'openai-chat', history: [{ role: 'assistant', content: '工作历史' }], journal: [{ id: 'one', status: 'completed', result: '已写入' }], pendingCalls: [], visibleText: '', partial: null, completed: false };
  let requestCount = 0, resumed;
  const fetcher = async (_url, request) => {
    const payload = JSON.parse(request.body); requestCount++;
    if (requestCount > 1) { resumed = payload; return eventsResponse([{ type: 'done' }]); }
    return eventsResponse([{ type: 'file', file: { path: 'saved.txt', data: Buffer.from('完成工具的文件').toString('base64') } }, { type: 'checkpoint', state }, { type: 'error', error: '连接中断', code: 'WORK_INTERRUPTED' }, { type: 'done' }]);
  };
  const { store, service } = fixture(t, { fetcher });
  store.run("INSERT INTO messages(id,chat_id,role,content,created_at) VALUES (?,?,?,?,?)", 'answer', 'chat', 'assistant', '当前已输出内容', new Date().toISOString());
  const requestOptions = options({ provider: { ...provider, protocol: 'openai-chat' }, context: { userId: 'owner', chatId: 'chat', assistantId: 'answer' } });
  await assert.rejects(collect(service.stream(requestOptions)), /连接中断/);
  const saved = store.get('SELECT * FROM work_checkpoints'); assert.ok(!saved.encrypted_state.includes('工作历史')); assert.deepEqual(JSON.parse(store.decrypt(saved.encrypted_state)), state);
  assert.deepEqual(service.continuationCandidates(requestOptions.context, [
    { id: 'a', model_id: 'different-model', protocol: 'openai-chat', runtime: 'api' },
    { id: 'b', model_id: state.model, protocol: state.protocol, runtime: 'api' },
    { id: 'c', model_id: state.model, protocol: 'anthropic', runtime: 'api' },
  ]).map(row => row.id), ['b']);
  service.close();
  const recovered = createWorkService({ store, runnerUrl: 'http://runner:3210', runnerToken: token, fetcher }); t.after(() => recovered.close());
  await collect(recovered.stream({ ...requestOptions, context: { ...requestOptions.context, continuation: true, resumeText: '精确末尾' } }));
  assert.deepEqual(resumed.resumeState, state); assert.equal(resumed.resumeText, '精确末尾'); assert.equal(resumed.files[0].path, 'output/saved.txt');
  await assert.rejects(collect(recovered.stream({ ...requestOptions, context: { ...requestOptions.context, userId: 'other', continuation: true } })), /无权/);
  await assert.rejects(collect(recovered.stream({ ...requestOptions, model: { modelId: 'different-model' }, context: { ...requestOptions.context, continuation: true } })), error => error.code === 'WORK_CHECKPOINT_INCOMPATIBLE');
  assert.equal(requestCount, 2);
});

for (const protocol of ['openai-chat', 'openai-responses']) test(`native gateway only permits selected ${protocol} endpoint, tools and token limit`, async t => {
  let forwarded;
  const broker = createBroker({ token, self: 'broker', docker: async () => '', publicRequest: async (url, options) => { forwarded = { url, ...options }; return { response: new Response('{}'), cleanup: async () => {} }; } });
  const task = { id: jobId, network: `ar-work-${jobId}`, config: job({ protocol, maxOutputTokens: 4096 }), provider: { ...provider, protocol, authMode: 'auto' }, jobToken: 'z'.repeat(43), controller: new AbortController(), calls: 0 };
  broker.jobs.set(jobId, task);
  const base = await listen(broker.server); t.after(() => broker.close());
  const endpoint = protocol === 'openai-chat' ? 'chat/completions' : 'responses';
  const limitName = protocol === 'openai-chat' ? 'max_completion_tokens' : 'max_output_tokens';
  const request = (body = {}, path = endpoint) => fetch(`${base}/proxy/${jobId}/v1/${path}`, { method: 'POST', headers: { authorization: `Bearer ${task.jobToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-test', [limitName]: 1024, ...body }) });
  assert.equal((await request({}, 'messages')).status, 403);
  assert.equal((await request({ [limitName]: 4097 })).status, 400);
  assert.equal((await request({ tools: [{ type: 'function', name: 'unknown_tool' }] })).status, 403);
  if (protocol === 'openai-responses') assert.equal((await request({ background: true })).status, 403);
  const tool = protocol === 'openai-chat' ? { type: 'function', function: { name: 'write_file', parameters: {} } } : { type: 'function', name: 'write_file', parameters: {} };
  assert.equal((await request({ tools: [tool], store: true })).status, 200);
  assert.equal(forwarded.url, `https://example.com/v1/${endpoint}`); assert.equal(forwarded.headers.authorization, `Bearer ${provider.apiKey}`); assert.equal(forwarded.headers['x-api-key'], undefined);
  if (protocol === 'openai-responses') assert.equal(JSON.parse(forwarded.body).store, false);
});

test('native Work applies Codex format only after enforcing the job token budget', async t => {
  let forwarded;
  const broker = createBroker({ token, self: 'broker', docker: async () => '', publicRequest: async (url, options) => { forwarded = { url, ...options }; return { response: new Response('{}'), cleanup: async () => {} }; } });
  const task = { id: jobId, config: job({ protocol: 'openai-responses', maxOutputTokens: 4096 }), provider: { ...provider, protocol: 'openai-responses', responsesProfile: 'codex' }, jobToken: 'z'.repeat(43), controller: new AbortController(), calls: 0 };
  broker.jobs.set(jobId, task);
  const base = await listen(broker.server); t.after(() => broker.close());
  const request = limit => fetch(`${base}/proxy/${jobId}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${task.jobToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-test', max_output_tokens: limit, input: [{ role: 'user', content: 'save a file' }], tools: [{ type: 'function', name: 'write_file', parameters: {} }] }) });
  assert.equal((await request(5000)).status, 400); assert.equal(forwarded, undefined);
  assert.equal((await request(4096)).status, 200);
  const payload = JSON.parse(forwarded.body);
  assert.equal(payload.max_output_tokens, undefined); assert.equal(payload.store, false);
  assert.equal(payload.tools[0].name, 'write_file'); assert.equal(payload.input[0].content[0].type, 'input_text');
  assert.match(forwarded.headers['user-agent'], /APIRouter compatibility/);
  assert.equal(forwarded.headers.authorization, `Bearer ${provider.apiKey}`);
});
