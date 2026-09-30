import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';
import { createStore } from '../server/store.mjs';
import { UpstreamError, streamReply } from '../server/upstream.mjs';
import { continuationAppender } from '../server/continuation.mjs';

function directory(t) { const path = mkdtempSync(join(tmpdir(), 'apirouter-resume-')); t.after(() => { const target = realpathSync(path); assert.ok(target.startsWith(realpathSync(tmpdir()) + sep) && target.includes('apirouter-resume-')); rmSync(target, { recursive: true, force: true }); }); return path; }
async function fixture(t, implementation) {
  const dataDir = directory(t), calls = [];
  const instance = createApp({ dataDir, setupToken: 'resume-setup', workFactory: () => ({ isConfigured: () => true, registerRoutes() {}, close() {}, async *stream(args) { calls.push(args); yield* implementation(args, calls.length); } }) });
  const server = createServer(instance.app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  // Hooks are FIFO, so close handles within the directory hook rather than
  // letting Windows attempt deletion while SQLite is open.
  const close = async () => { instance.abortAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); instance.close(); };
  const base = `http://127.0.0.1:${server.address().port}`;
  let session;
  const request = async (path, method = 'GET', body, raw = false) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(session ? { Cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (raw) return response;
    const text = await response.text(); return { status: response.status, text, data: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : undefined, response };
  };
  const setup = await request('/api/auth/setup', 'POST', { setupToken: 'resume-setup', email: 'resume@example.com', name: 'Resume', password: 'resume-password-long-2026' });
  session = { cookie: setup.response.headers.get('set-cookie').split(';')[0], csrfToken: setup.data.csrfToken };
  const provider = (await request('/api/admin/providers', 'POST', { name: 'Hidden', baseUrl: 'https://example.com', apiKey: 'test-secret', protocol: 'anthropic', runtime: 'claude-code' })).data.provider;
  const model = (await request('/api/admin/models', 'POST', { providerId: provider.id, modelId: 'test-long-context', contextWindow: 1_000_000, maxOutputTokens: 8000 })).data.model;
  const chat = (await request('/api/chats', 'POST', { modelId: model.id })).data.chat;
  return { instance, request, chat, model, calls, close, dataDir };
}

test('timeout continuation appends to the same saved message and typed continue does not resend the original request', async t => {
  const prefix = '下面是已经生成并且保存的回答内容。\n```python\nprint("hello';
  const f = await fixture(t, async function* (args, number) {
    if (number === 1) { yield { type: 'delta', text: prefix }; throw new UpstreamError('timeout', 'UPSTREAM_TIMEOUT'); }
    assert.equal(args.context.continuation, true); assert.equal(args.context.resumeText, prefix);
    assert.ok(args.messages.some(message => message.role === 'assistant' && message.content === prefix));
    assert.match(args.messages.at(-1).content, /Output only the missing continuation/);
    // Deliberately simulate an upstream that repeats the exact existing prefix.
    yield { type: 'delta', text: prefix.slice(0, 20) }; yield { type: 'delta', text: prefix.slice(20) + '")\n```\n完成。' };
  });
  try {
    const first = await f.request(`/api/chats/${f.chat.id}/messages`, 'POST', { content: '请写代码' }); assert.match(first.text, /event: error/);
    const saved = (await f.request(`/api/chats/${f.chat.id}`)).data.messages.at(-1);
    assert.equal(saved.content, prefix); assert.equal(saved.canContinue, true);
    const resumed = await f.request(`/api/chats/${f.chat.id}/messages`, 'POST', { content: '继续' }); assert.match(resumed.text, /event: done/);
    const messages = (await f.request(`/api/chats/${f.chat.id}`)).data.messages;
    assert.equal(messages.length, 2); assert.equal(messages[1].id, saved.id);
    assert.equal(messages[1].content, prefix + '")\n```\n完成。'); assert.equal(messages[1].status, 'complete');
    assert.equal(f.instance.store.get('SELECT COUNT(*) AS n FROM message_chunks').n, 0);
    assert.equal((await f.request(`/api/chats/${f.chat.id}/continue`, 'POST', { messageId: 'wrong' })).status, 409);
  } finally { await f.close(); }
});

test('ordinary follow-ups retain incomplete assistant context, and histories over 300 messages are sent intact', async t => {
  const f = await fixture(t, async function* () { yield { type: 'delta', text: 'answer' }; });
  try {
    const stamp = new Date().toISOString();
    for (let i = 0; i < 305; i++) f.instance.store.run('INSERT INTO messages(id,chat_id,role,content,status,created_at) VALUES (?,?,?,?,?,?)', `history-${i}`, f.chat.id, i % 2 ? 'assistant' : 'user', `long-history-${i}`, i === 303 ? 'error' : 'complete', stamp);
    const sent = await f.request(`/api/chats/${f.chat.id}/messages`, 'POST', { content: '解释之前的内容' }); assert.equal(sent.status, 200);
    assert.equal(f.calls[0].messages.length, 306); assert.equal(f.calls[0].messages[303].content, 'long-history-303');
    const admin = (await f.request('/api/admin/models')).data.models[0]; assert.equal(admin.contextWindow, 1_000_000);
    const changed = await f.request(`/api/admin/models/${admin.id}`, 'PATCH', { contextWindow: 2_000_000, maxOutputTokens: 16000 }); assert.equal(changed.data.model.contextWindow, 2_000_000);
  } finally { await f.close(); }
});

test('one user runs four independent tasks, can stop one, and resumes its saved delta', async t => {
  const f = await fixture(t, async function* (args) {
    if (args.context.continuation) { yield { type: 'delta', text: ' continued' }; return; }
    yield { type: 'delta', text: `partial-${args.context.chatId}` };
    await new Promise((resolve, reject) => { if (args.signal.aborted) reject(args.signal.reason); else args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true }); });
  });
  const responses = [];
  try {
    const chats = [f.chat];
    for (let i = 1; i < 5; i++) chats.push((await f.request('/api/chats', 'POST', { modelId: f.model.id })).data.chat);
    for (const chat of chats.slice(0, 4)) { const response = await f.request(`/api/chats/${chat.id}/messages`, 'POST', { content: 'wait' }, true); assert.equal(response.status, 200); responses.push(response); }
    for (let tries = 0; tries < 50 && f.calls.length < 4; tries++) await new Promise(resolve => setTimeout(resolve, 10));
    const running = (await f.request('/api/chats')).data.chats.filter(chat => chat.generating); assert.equal(running.length, 4);
    const saved = (await f.request(`/api/chats/${chats[0].id}`)).data; assert.equal(saved.generating, true); assert.equal(saved.messages.at(-1).content, `partial-${chats[0].id}`);
    assert.equal((await f.request(`/api/chats/${chats[0].id}/messages`, 'POST', { content: 'same chat' })).status, 409);
    assert.equal((await f.request(`/api/chats/${chats[4].id}/messages`, 'POST', { content: 'too many' })).status, 429);
    await f.request(`/api/chats/${chats[0].id}/stop`, 'POST', {}); await responses[0].text();
    assert.equal((await f.request('/api/chats')).data.chats.filter(chat => chat.generating).length, 3);
    const resumed = await f.request(`/api/chats/${chats[0].id}/continue`, 'POST', {}); assert.match(resumed.text, /event: done/);
    assert.equal((await f.request(`/api/chats/${chats[0].id}`)).data.messages.at(-1).content, `partial-${chats[0].id} continued`);
    for (const chat of chats.slice(1, 4)) await f.request(`/api/chats/${chat.id}/stop`, 'POST', {});
    await Promise.all(responses.slice(1).map(response => response.text()));
  } finally { await f.close(); }
});

test('durable delta journal survives reopening the database after an unclean interruption', t => {
  const dataDir = directory(t); let store = createStore(dataDir);
  store.run("INSERT INTO users(id,name,email,password,role,created_at) VALUES ('u','u','u@e.test','x','admin','now')");
  store.run("INSERT INTO chats(id,user_id,title,created_at,updated_at) VALUES ('c','u','test','now','now')");
  store.run("INSERT INTO messages(id,chat_id,role,content,status,created_at) VALUES ('m','c','assistant','saved','streaming','now')");
  store.run("INSERT INTO message_chunks(message_id,content) VALUES ('m',' 中文'),('m',' suffix')"); store.close();
  store = createStore(dataDir);
  try { const row = store.get("SELECT * FROM messages WHERE id='m'"); assert.equal(row.content, 'saved 中文 suffix'); assert.equal(row.status, 'error'); assert.match(row.error, /继续/); assert.equal(store.get('SELECT COUNT(*) AS n FROM message_chunks').n, 0); }
  finally { store.close(); }
});

test('long prompts beyond the former JSON and character limits reach the model intact', async t => {
  const f = await fixture(t, async function* () { yield { type: 'delta', text: 'ok' }; });
  try {
    const content = '长上下文'.repeat(120_000);
    const result = await f.request(`/api/chats/${f.chat.id}/messages`, 'POST', { content });
    assert.equal(result.status, 200); assert.match(result.text, /event: done/);
    assert.equal(f.calls[0].messages[0].content, content);
    assert.equal((await f.request('/api/chats', 'POST', { title: content })).status, 413);
  } finally { await f.close(); }
});

test('continuation overlap filter preserves short new suffixes and removes exact long repeated tails', () => {
  const old = 'prefix '.repeat(20) + '\nThis is a sufficiently long final unfinished sentence';
  const filter = continuationAppender(old); let output = filter.push('This is a sufficiently long final unfinished sentence') + filter.push(' completed.') + filter.finish(); assert.equal(output, ' completed.');
  const short = continuationAppender(old); assert.equal(short.push('。') + short.finish(), '。');
});

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic']) test(`${protocol} JSON output limit preserves text before reporting incomplete`, async t => {
  const oldPrivate = process.env.ALLOW_PRIVATE_UPSTREAM; process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  const body = protocol === 'openai-chat' ? { choices: [{ message: { content: 'partial result' }, finish_reason: 'length' }] } : protocol === 'anthropic' ? { content: [{ type: 'text', text: 'partial result' }], stop_reason: 'max_tokens' } : { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial result' }] }] };
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const events = [];
    await assert.rejects(async () => { for await (const event of streamReply({ provider: { baseUrl: `http://127.0.0.1:${server.address().port}`, protocol, apiKey: 'local-test' }, model: { modelId: 'test' }, messages: [{ role: 'user', content: 'long' }] })) events.push(event); }, { code: 'OUTPUT_LIMIT_REACHED' });
    assert.equal(events[0].text, 'partial result');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (oldPrivate === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM; else process.env.ALLOW_PRIVATE_UPSTREAM = oldPrivate; }
});

test('active streaming refreshes the idle timer instead of cutting output at a fixed duration', async () => {
  const oldPrivate = process.env.ALLOW_PRIVATE_UPSTREAM, oldTimeout = process.env.UPSTREAM_TIMEOUT_MS; process.env.ALLOW_PRIVATE_UPSTREAM = 'true'; process.env.UPSTREAM_TIMEOUT_MS = '120';
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/event-stream'); let count = 0;
    const timer = setInterval(() => { res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '续' } }] })}\n\n`); if (++count === 5) { clearInterval(timer); res.end('data: [DONE]\n\n'); } }, 55); res.on('close', () => clearInterval(timer));
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { const output = []; for await (const event of streamReply({ provider: { baseUrl: `http://127.0.0.1:${server.address().port}`, protocol: 'openai-chat', apiKey: 'local' }, model: { modelId: 'test' }, messages: [{ role: 'user', content: 'long' }] })) output.push(event); assert.equal(output.filter(event => event.type === 'delta').length, 5); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (oldPrivate === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM; else process.env.ALLOW_PRIVATE_UPSTREAM = oldPrivate; if (oldTimeout === undefined) delete process.env.UPSTREAM_TIMEOUT_MS; else process.env.UPSTREAM_TIMEOUT_MS = oldTimeout; }
});
