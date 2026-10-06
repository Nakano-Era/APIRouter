import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';

const Zip = createRequire(import.meta.resolve('exceljs'))('jszip');

test('HTTP archives and binary originals reach Work intact; Chat receives previews; downloads remain private and inert', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-upload-http-'));
  const previous = process.env.ALLOW_PRIVATE_UPSTREAM;
  process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  const chatCalls = [], workCalls = [];
  const upstream = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    chatCalls.push(JSON.parse(text));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"read preview"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const instance = createApp({ dataDir: directory, setupToken: 'upload-test-setup', workFactory: () => ({
    isConfigured: () => true, registerRoutes() {}, close() {},
    async *stream(options) { workCalls.push(options); yield { type: 'delta', text: 'Work received files' }; },
  }) });
  const server = createServer(instance.app);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    instance.abortAll(); server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([server, upstream].map(s => new Promise(resolve => s.close(resolve)))); instance.close();
    if (previous === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM; else process.env.ALLOW_PRIVATE_UPSTREAM = previous;
    const target = realpathSync(directory); assert.ok(target.startsWith(realpathSync(tmpdir()) + sep) && target.includes('apirouter-upload-http-'));
    rmSync(target, { recursive: true, force: true });
  });
  let session;
  async function request(path, method = 'GET', body, identity = session) {
    const form = body instanceof FormData;
    const response = await fetch(base + path, { method, headers: {
      ...(identity ? { Cookie: identity.cookie, 'x-csrf-token': identity.csrfToken } : {}),
      ...(!form && body !== undefined ? { 'content-type': 'application/json' } : {}),
    }, ...(body !== undefined ? { body: form ? body : JSON.stringify(body) } : {}) });
    const bytes = Buffer.from(await response.arrayBuffer()), text = bytes.toString();
    return { response, status: response.status, bytes, text, data: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null };
  }
  const setup = await request('/api/auth/setup', 'POST', { setupToken: 'upload-test-setup', name: 'Upload Admin', email: 'upload@example.com', password: 'upload-password-test-only' });
  assert.equal(setup.status, 201);
  session = { cookie: setup.response.headers.get('set-cookie').split(';')[0], csrfToken: setup.data.csrfToken };
  const provider = await request('/api/admin/providers', 'POST', { name: 'Test source', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'sk-synthetic-upload', protocol: 'openai-chat', runtime: 'api' });
  assert.equal(provider.status, 201);
  const added = await request('/api/admin/models', 'POST', { providerId: provider.data.provider.id, modelId: 'upload-model', routeKey: 'Upload Model' });
  assert.equal(added.status, 201);
  const modelId = (await request('/api/models')).data.models[0].id;
  const archive = new Zip(); archive.file('项目/main.py', 'print("archive-text-marker")'); archive.file('data.bin', Buffer.from([0, 255, 1]));
  const zipped = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const binary = Buffer.from([0, 255, 27, 89, 0, 250, 17, 128]);
  const svg = Buffer.from('<svg onload="alert(1)"><text>fixture</text></svg>');
  const originals = [zipped, binary, svg, Buffer.from('second-file-with-same-name')];
  const names = ['project.zip', 'database.sqlite', 'diagram.svg', 'project.zip'];
  // Upload a second archive with the same display name to verify isolated input paths.
  const second = new Zip(); second.file('second.txt', originals[3]); originals[3] = await second.generateAsync({ type: 'nodebuffer' });
  const form = new FormData(); originals.forEach((bytes, i) => form.append('files', new Blob([bytes]), names[i]));
  const uploaded = await request('/api/files', 'POST', form);
  assert.equal(uploaded.status, 201, uploaded.text);
  const files = uploaded.data.files;
  assert.deepEqual(files.map(f => f.kind), ['archive', 'file', 'text', 'archive']);
  assert.ok(!JSON.stringify(files).includes('archive-text-marker'), 'public attachment metadata does not include extracted text');
  for (const [index, file] of files.entries()) {
    const download = await request(file.url);
    assert.equal(download.status, 200); assert.deepEqual(download.bytes, originals[index]);
    assert.match(download.response.headers.get('content-disposition'), /^attachment;/);
    assert.match(download.response.headers.get('content-type'), /^application\/octet-stream/);
    assert.equal(download.response.headers.get('x-content-type-options'), 'nosniff');
  }
  const chat = (await request('/api/chats', 'POST', { modelId })).data.chat;
  const answer = await request(`/api/chats/${chat.id}/messages`, 'POST', { content: 'Read these attachments', attachmentIds: files.map(f => f.id) });
  assert.equal(answer.status, 200); assert.match(answer.text, /event: done/); assert.equal(chatCalls.length, 1);
  const outgoing = JSON.stringify(chatCalls[0]);
  assert.match(outgoing, /archive-text-marker/); assert.match(outgoing, /无法直接读取二进制/);
  assert.ok(!outgoing.includes(zipped.toString('base64')) && !outgoing.includes(binary.toString('base64')));
  assert.ok(!outgoing.includes('originalFile') && !outgoing.includes('/workspace/input/'));
  const work = await request(`/api/chats/${chat.id}/messages`, 'POST', { content: 'Inspect originals inside Work', mode: 'work', attachmentIds: [files[0].id] });
  assert.equal(work.status, 200); assert.match(work.text, /event: done/); assert.equal(workCalls.length, 1);
  const supplied = workCalls[0].messages.flatMap(m => m.attachments || []);
  assert.equal(supplied.length, 5);
  supplied.slice(0, 4).forEach((file, i) => {
    assert.equal(file.originalFile.path, `input/${files[i].id}/${names[i]}`);
    assert.deepEqual(Buffer.from(file.originalFile.data, 'base64'), originals[i]);
  });
  assert.notEqual(supplied[0].originalFile.path, supplied[3].originalFile.path);
  assert.equal(supplied[0], supplied[4], 'repeated historical references reuse the attachment and raw bytes');
  const invite = await request('/api/admin/invites', 'POST', { email: 'other-upload@example.com', days: 7 });
  assert.equal(invite.status, 201);
  const accepted = await request('/api/auth/invite/accept', 'POST', { token: invite.data.invite.token, name: 'Other user', email: 'other-upload@example.com', password: 'other-upload-test-password' }, null);
  assert.equal(accepted.status, 201);
  const other = { cookie: accepted.response.headers.get('set-cookie').split(';')[0], csrfToken: accepted.data.csrfToken };
  assert.equal((await request(files[0].url, 'GET', undefined, other)).status, 404);
  const otherChat = (await request('/api/chats', 'POST', { modelId }, other)).data.chat;
  assert.equal((await request(`/api/chats/${otherChat.id}/messages`, 'POST', { content: 'Use private attachment', mode: 'work', attachmentIds: [files[0].id] }, other)).status, 404);
  assert.equal(workCalls.length, 1, 'unauthorized attachment never reaches the runner');
});
