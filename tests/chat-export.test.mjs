import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { inflateRawSync } from 'node:zlib';
import express from 'express';
import { createStore } from '../server/store.mjs';
import { createChatExport } from '../server/chat-export.mjs';

function unzip(bytes) {
  // Read ZIP central-directory lengths so entries using streaming data
  // descriptors can be checked without a second production dependency.
  const files = new Map(), end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'zip has a complete central directory');
  let cursor = bytes.readUInt32LE(end + 16);
  const count = bytes.readUInt16LE(end + 10);
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const compression = bytes.readUInt16LE(cursor + 10), compressedSize = bytes.readUInt32LE(cursor + 20), fileNameSize = bytes.readUInt16LE(cursor + 28), extraSize = bytes.readUInt16LE(cursor + 30), commentSize = bytes.readUInt16LE(cursor + 32), local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + fileNameSize).toString('utf8');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + compressedSize);
    files.set(name, (compression === 8 ? inflateRawSync(compressed) : compressed).toString('utf8'));
    cursor += 46 + fileNameSize + extraSize + commentSize;
  }
  return files;
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-chat-export-')), store = createStore(directory), timestamp = '2026-10-01T04:00:00.000Z';
  for (const user of ['admin', 'member', 'disabled']) store.run('INSERT INTO users(id,name,email,password,role,disabled,created_at) VALUES(?,?,?,?,?,?,?)', user, `${user} 名称`, `${user}@example.com`, 'SECRET_PASSWORD_HASH', user === 'admin' ? user : 'user', user === 'disabled' ? 1 : 0, timestamp);
  store.run('INSERT INTO providers(id,name,base_url,protocol,encrypted_key,key_hint,created_at) VALUES(?,?,?,?,?,?,?)', 'provider', 'SECRET_PROVIDER_NAME', 'https://secret-provider.invalid', 'openai-chat', 'SECRET_API_KEY', 'secret-hint', timestamp);
  for (const user of ['admin', 'member', 'disabled']) {
    store.run('INSERT INTO chats(id,user_id,title,model_id,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', `chat-${user}`, user, user === 'member' ? '../../聊天/标题' : `${user} 的聊天`, 'route-public', user === 'member' ? 1 : 0, timestamp, timestamp);
    store.run('INSERT INTO messages(id,chat_id,role,content,reasoning,status,attachment_ids,created_at) VALUES(?,?,?,?,?,?,?,?)', `message-${user}`, `chat-${user}`, 'assistant', `${user} 的正文`, `${user} 的思考`, user === 'member' ? 'streaming' : 'complete', user === 'member' ? '["file"]' : '[]', timestamp);
  }
  store.run('INSERT INTO message_chunks(message_id,content,kind) VALUES(?,?,?)', 'message-member', '已保存增量', 'content');
  store.run('INSERT INTO message_chunks(message_id,content,kind) VALUES(?,?,?)', 'message-member', '思考增量', 'reasoning');
  store.run('INSERT INTO files(id,user_id,name,mime,size,kind,text_content,created_at) VALUES(?,?,?,?,?,?,?,?)', 'file', 'member', '附件.txt', 'text/plain', 24, 'text', 'SECRET_ATTACHMENT_BODY', timestamp);
  store.db.exec('CREATE TABLE work_artifacts(id TEXT PRIMARY KEY,user_id TEXT,chat_id TEXT,name TEXT,path TEXT,mime TEXT,size INTEGER,body BLOB,created_at TEXT)');
  store.run('INSERT INTO work_artifacts VALUES(?,?,?,?,?,?,?,?,?)', 'artifact', 'member', 'chat-member', '源码.zip', '源码.zip', 'application/zip', 22, Buffer.from('SECRET_ARTIFACT_BODY'), timestamp);
  const app = express(), service = createChatExport({ store, clock: () => Date.parse(timestamp) });
  app.use((req, _res, next) => { req.user = store.get('SELECT * FROM users WHERE id=? AND disabled=0', req.get('x-user') || ''); next(); });
  const fault = (status, message) => Object.assign(new Error(message), { status });
  const auth = (req, _res, next) => req.user ? next() : next(fault(401, 'auth'));
  const admin = (req, _res, next) => req.user.role === 'admin' ? next() : next(fault(403, 'admin'));
  service.registerRoutes(app, { auth, admin });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, base, download: ({ format = 'json', user = 'admin', userId, signal } = {}) => {
    const query = new URLSearchParams({ format });
    if (userId !== undefined) query.set('userId', userId);
    return fetch(`${base}/api/admin/chats/export?${query}`, { headers: { 'x-user': user }, signal });
  } };
}

test('chat archive endpoint rejects anonymous and ordinary users and validates format', async t => {
  const f = await fixture(t);
  assert.equal((await f.download({ user: '' })).status, 401);
  assert.equal((await f.download({ user: 'member' })).status, 403);
  assert.equal((await f.download({ user: 'disabled' })).status, 401);
  assert.equal((await f.download({ format: 'csv' })).status, 400);
  assert.equal((await f.download({ user: 'member', userId: 'member' })).status, 403);
  assert.equal((await f.download({ userId: '' })).status, 400);
  assert.equal((await f.download({ userId: ' ' })).status, 400);
  assert.equal((await f.download({ userId: 'x'.repeat(201) })).status, 400);
  assert.equal((await fetch(`${f.base}/api/admin/chats/export?userId=admin&userId=member`, { headers: { 'x-user': 'admin' } })).status, 400);
});

test('JSON archive includes every user and archived chat, separates thinking, saves streaming chunks, and excludes configuration secrets and binary content', async t => {
  const f = await fixture(t), response = await f.download();
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(response.headers.get('content-disposition'), /^attachment; filename="APIRouter-chats-/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const files = unzip(Buffer.from(await response.arrayBuffer())), manifest = JSON.parse(files.get('manifest.json'));
  assert.equal(manifest.users, 3); assert.equal(manifest.chats, 3); assert.equal(manifest.messages, 3); assert.equal(files.size, 7);
  assert.equal(manifest.scope, 'all'); assert.equal(manifest.userId, null);
  assert.ok(files.has('users/user-disabled/chats/chat-chat-disabled.json'));
  const chat = JSON.parse(files.get('users/user-member/chats/chat-chat-member.json'));
  assert.equal(chat.archived, true); assert.equal(chat.title, '../../聊天/标题');
  assert.equal(chat.messages[0].content, 'member 的正文已保存增量');
  assert.equal(chat.messages[0].reasoning, 'member 的思考思考增量');
  assert.equal(chat.messages[0].status, 'streaming');
  assert.equal(chat.messages[0].attachments[0].name, '附件.txt'); assert.equal(chat.artifacts[0].name, '源码.zip');
  const full = [...files.values()].join('\n');
  for (const secret of ['SECRET_PASSWORD_HASH', 'SECRET_PROVIDER_NAME', 'SECRET_API_KEY', 'SECRET_ATTACHMENT_BODY', 'SECRET_ARTIFACT_BODY', 'secret-provider.invalid']) assert.ok(!full.includes(secret), secret);
  assert.ok([...files.keys()].every(name => !name.includes('../') && !name.includes('聊天')));
});

test('selected-user JSON archive contains only that user, archived chats, chunks and owned file metadata', async t => {
  const f = await fixture(t);
  // Even a stale/corrupt cross-user attachment reference must not include another user's metadata.
  f.store.run('INSERT INTO files(id,user_id,name,mime,size,kind,created_at) VALUES(?,?,?,?,?,?,?)', 'other-file', 'admin', 'OTHER_USER_FILE', 'text/plain', 5, 'text', '2026-10-01T04:00:00.000Z');
  f.store.run('UPDATE messages SET attachment_ids=? WHERE id=?', '["file","other-file"]', 'message-member');
  f.store.run('INSERT INTO work_artifacts VALUES(?,?,?,?,?,?,?,?,?)', 'other-artifact', 'admin', 'chat-member', 'OTHER_USER_ARTIFACT', 'private.txt', 'text/plain', 3, Buffer.from('secret'), '2026-10-01T04:00:00.000Z');
  const response = await f.download({ userId: 'member' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /APIRouter-chats-user-member-json-/);
  const files = unzip(Buffer.from(await response.arrayBuffer())), manifest = JSON.parse(files.get('manifest.json'));
  assert.deepEqual([manifest.scope, manifest.userId, manifest.users, manifest.chats, manifest.messages], ['user', 'member', 1, 1, 1]);
  assert.deepEqual([...files.keys()].sort(), ['manifest.json', 'users/user-member/chats/chat-chat-member.json', 'users/user-member/user.json']);
  assert.equal(JSON.parse(files.get('users/user-member/user.json')).email, 'member@example.com');
  const chat = JSON.parse(files.get('users/user-member/chats/chat-chat-member.json'));
  assert.equal(chat.archived, true);
  assert.equal(chat.messages[0].content, 'member 的正文已保存增量');
  assert.equal(chat.messages[0].reasoning, 'member 的思考思考增量');
  assert.deepEqual(chat.messages[0].attachments.map(file => file.id), ['file']);
  assert.deepEqual(chat.artifacts.map(file => file.id), ['artifact']);
  const full = [...files.values()].join('\n');
  for (const privateValue of ['admin@example.com', 'disabled@example.com', 'admin 的正文', 'disabled 的正文', 'OTHER_USER_FILE', 'OTHER_USER_ARTIFACT', 'SECRET_PASSWORD_HASH', 'SECRET_API_KEY', 'SECRET_ATTACHMENT_BODY', 'SECRET_ARTIFACT_BODY']) assert.ok(!full.includes(privateValue), privateValue);
});

test('selected-user Markdown supports disabled accounts and excludes other accounts', async t => {
  const f = await fixture(t), response = await f.download({ userId: 'disabled', format: 'markdown' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /APIRouter-chats-user-disabled-markdown-/);
  const files = unzip(Buffer.from(await response.arrayBuffer()));
  assert.equal(files.size, 3);
  assert.equal(JSON.parse(files.get('users/user-disabled/user.json')).disabled, true);
  assert.match(files.get('users/user-disabled/chats/chat-chat-disabled.md'), /disabled 的正文/);
  assert.equal(JSON.parse(files.get('manifest.json')).messages, 1);
  assert.ok(![...files.keys()].some(name => name.includes('user-admin') || name.includes('user-member')));
});

test('user without chats still exports their profile; nonexistent user returns 404 without a ZIP', async t => {
  const f = await fixture(t);
  f.store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES(?,?,?,?,?,?)', 'empty', 'Empty account', 'empty@example.com', 'SECRET_PASSWORD_HASH', 'user', '2026-10-01T04:00:00.000Z');
  const empty = await f.download({ userId: 'empty' }), files = unzip(Buffer.from(await empty.arrayBuffer()));
  assert.equal(files.size, 2); assert.ok(files.has('users/user-empty/user.json'));
  const manifest = JSON.parse(files.get('manifest.json'));
  assert.deepEqual([manifest.users, manifest.chats, manifest.messages], [1, 0, 0]);
  const missing = await f.download({ userId: 'missing' });
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /所选用户不存在/);
  assert.equal(missing.headers.get('content-disposition'), null);
  const next = await f.download({ userId: 'member' });
  assert.equal(next.status, 200);
  await next.arrayBuffer();
});

test('Markdown export keeps body and reasoning in distinct sections and includes message/file metadata', async t => {
  const f = await fixture(t);
  f.store.run('UPDATE messages SET reasoning=? WHERE id=?', '第一段\n```\n```js\n第二段', 'message-member');
  const response = await f.download({ format: 'markdown' }), files = unzip(Buffer.from(await response.arrayBuffer()));
  const text = files.get('users/user-member/chats/chat-chat-member.md');
  assert.match(text, /### 正文\n\nmember 的正文已保存增量/);
  assert.match(text, /### 思考与过程（与正文分开）\n\n````\n第一段/);
  assert.match(text, /## 工作文件元数据/); assert.match(text, /源码.zip/); assert.match(text, /附件.txt/);
  assert.equal(JSON.parse(files.get('manifest.json')).format, 'markdown');
});

test('export holds a consistent read snapshot while new chats continue to be written', async t => {
  const f = await fixture(t), response = await f.download();
  f.store.run('INSERT INTO chats(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)', 'late-chat', 'member', 'created after snapshot', '2026-10-01T04:01:00.000Z', '2026-10-01T04:01:00.000Z');
  f.store.run('UPDATE messages SET content=? WHERE id=?', 'later edit', 'message-member');
  const files = unzip(Buffer.from(await response.arrayBuffer()));
  assert.equal(JSON.parse(files.get('manifest.json')).chats, 3);
  assert.ok(!files.has('users/user-member/chats/chat-late-chat.json'));
  assert.equal(JSON.parse(files.get('users/user-member/chats/chat-chat-member.json')).messages[0].content, 'member 的正文已保存增量');
  const after = unzip(Buffer.from(await (await f.download()).arrayBuffer()));
  assert.equal(JSON.parse(after.get('manifest.json')).chats, 4);
  assert.ok(after.has('users/user-member/chats/chat-late-chat.json'));
});

test('abandoned export releases its reader and a following export remains available', async t => {
  const f = await fixture(t), controller = new AbortController();
  const response = await f.download({ signal: controller.signal });
  controller.abort();
  await response.body?.cancel().catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  const next = await f.download();
  assert.equal(next.status, 200);
  assert.equal(JSON.parse(unzip(Buffer.from(await next.arrayBuffer())).get('manifest.json')).chats, 3);
});
