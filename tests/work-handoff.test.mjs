import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { handoffCheckpoint, priorHandoffOperation } from '../runner/work-handoff.mjs';
import { runNativeAgent } from '../runner/native-agent.mjs';
import { createStore } from '../server/store.mjs';
import { createWorkService } from '../server/work.mjs';

const record = (overrides = {}) => ({ id: 'old-write', name: 'write_file', arguments: JSON.stringify({ path: 'output/file.txt', content: 'already-written' }), status: 'completed', result: { written: true }, ...overrides });
const checkpoint = (overrides = {}) => ({ version: 1, model: 'old-model', protocol: 'anthropic', history: [{ role: 'user', content: '完成报告' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'private thinking', signature: 'signed-secret' }, { type: 'text', text: '已完成第一部分。' }] }], journal: [record()], pendingCalls: [], partial: null, visibleText: '已完成第一部分。', completed: false, ...overrides });
const job = (resumeState, extra = {}) => ({ protocol: resumeState.protocol, model: resumeState.model, mode: 'work', prompt: '完成报告', systemPrompt: '', skills: [], webSearch: false, images: [], resumeState, resumeText: resumeState.visibleText, continuation: true, gateway: 'http://gateway/proxy/job', jobToken: 'fixture', limits: { maxTurns: 4 }, ...extra });
const reply = (content, calls) => Response.json({ choices: [{ finish_reason: calls ? 'tool_calls' : 'stop', message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) } }] });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
async function workspace(t, beforeCleanup = () => {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'apirouter-handoff-')); await mkdir(join(cwd, 'output'));
  t.after(async () => { beforeCleanup(); const path = await realpath(cwd); assert.ok(path.startsWith(await realpath(tmpdir()) + sep) && path.includes('apirouter-handoff-')); await rm(path, { recursive: true, force: true }); });
  return cwd;
}

test('native handoff converts all protocols without signatures and keeps authoritative visible output', () => {
  for (const protocol of ['anthropic', 'openai-chat', 'openai-responses']) {
    const original = checkpoint(), state = handoffCheckpoint(original, { model: 'new-model', protocol, visibleText: '已保存正文。' });
    assert.equal(state.model, 'new-model'); assert.equal(state.protocol, protocol); assert.equal(state.visibleText, '已保存正文。');
    assert.ok(!JSON.stringify(state.history).includes('private thinking')); assert.ok(!JSON.stringify(state.history).includes('signed-secret'));
    assert.match(JSON.stringify(state.history), /完成报告/); assert.match(JSON.stringify(state.history), /already-written/);
    assert.equal(state.journal[0].handoffRecord, true); assert.deepEqual(state.pendingCalls, []);
    assert.equal(original.journal[0].handoffRecord, undefined);
  }
});

test('handoff marks interrupted and transport-pending operations uncertain without replay', () => {
  const state = handoffCheckpoint(checkpoint({ journal: [record({ status: 'pending' })], pendingCalls: [{ id: 'queued', name: 'run_command', arguments: '{"command":"echo append"}' }] }), { model: 'new', protocol: 'openai-chat' });
  assert.deepEqual(state.journal.map(row => row.status), ['uncertain', 'uncertain']);
  assert.ok(state.journal.every(row => row.result.uncertain));
  assert.deepEqual(state.pendingCalls, []);
});

test('handoff uses the latest outcome for repeated operations and rejects incomplete completed records', () => {
  const state = handoffCheckpoint(checkpoint({ journal: [record(), record({ id: 'latest-write', status: 'pending' })] }), { model: 'new', protocol: 'openai-chat' });
  assert.equal(priorHandoffOperation(state.journal, record()).status, 'uncertain');
  assert.throws(() => handoffCheckpoint(checkpoint({ journal: [record({ result: undefined })] }), { model: 'new', protocol: 'openai-chat' }), { code: 'WORK_FALLBACK_UNSAFE' });
});

test('handoff deduplicates completed writes by canonical parameters despite new tool IDs and reexecutes inspection tools', async t => {
  const cwd = await workspace(t); await writeFile(join(cwd, 'output/file.txt'), 'newer-file-must-survive');
  const state = handoffCheckpoint(checkpoint({ journal: [record(), record({ id: 'inspect', name: 'read_file', arguments: '{"path":"output/file.txt"}', result: { content: 'outdated' } })] }), { model: 'new', protocol: 'openai-chat' });
  let calls = 0, request;
  await runNativeAgent(job(state), { cwd, fetcher: async (_url, options) => {
    request = JSON.parse(options.body);
    if (++calls === 1) return reply(null, [call('new-write', 'write_file', { content: 'already-written', path: 'output/file.txt' }), call('inspect', 'read_file', { path: 'output/file.txt' })]);
    const outputs = request.messages.filter(row => row.role === 'tool').map(row => JSON.parse(row.content));
    assert.equal(outputs[0].written, true); assert.equal(outputs[1].content, 'newer-file-must-survive');
    return reply('接着完成。');
  } });
  assert.equal(await readFile(join(cwd, 'output/file.txt'), 'utf8'), 'newer-file-must-survive');
});

test('handoff never automatically reruns an uncertain write with a new call ID', async t => {
  const cwd = await workspace(t); await writeFile(join(cwd, 'output/file.txt'), 'existing');
  const state = handoffCheckpoint(checkpoint({ journal: [record({ status: 'pending' })] }), { model: 'new', protocol: 'openai-chat' });
  let count = 0;
  await runNativeAgent(job(state), { cwd, fetcher: async (_url, options) => {
    if (++count === 1) return reply(null, [call('retry', 'write_file', { path: 'output/file.txt', content: 'already-written' })]);
    assert.equal(JSON.parse(JSON.parse(options.body).messages.at(-1).content).uncertain, true);
    return reply('需要检查现有文件。');
  } });
  assert.equal(await readFile(join(cwd, 'output/file.txt'), 'utf8'), 'existing');
});

test('Work handoff accepts native cross-model candidates but rejects CLI operations without a reliable journal', async t => {
  let store, service, sent;
  const cwd = await workspace(t, () => { service?.close(); store?.close(); }); store = createStore(cwd);
  service = createWorkService({ store, dataDir: cwd, runnerUrl: 'http://runner:3210', runnerToken: 'a'.repeat(43), fetcher: async (_url, options) => { sent = JSON.parse(options.body); return new Response('{"type":"done"}\n'); } });
  const stamp = new Date().toISOString();
  store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES(?,?,?,?,?,?)', 'owner', 'Owner', 'owner@example.com', 'unused', 'user', stamp);
  store.run('INSERT INTO chats(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)', 'chat', 'owner', 'Work', stamp, stamp);
  store.run('INSERT INTO messages(id,chat_id,role,content,status,created_at) VALUES(?,?,?,?,?,?)', 'assistant', 'chat', 'assistant', '保存正文', 'error', stamp);
  store.run('INSERT INTO work_checkpoints(assistant_id,user_id,chat_id,model,protocol,encrypted_state,updated_at) VALUES(?,?,?,?,?,?,?)', 'assistant', 'owner', 'chat', 'old-model', 'anthropic', store.encrypt(JSON.stringify(checkpoint())), stamp);
  const context = { userId: 'owner', chatId: 'chat', assistantId: 'assistant', continuation: true, fallback: true, committedTools: true, resumeText: '保存正文' };
  const candidate = { runtime: 'api', model_id: 'new', protocol: 'openai-chat' };
  assert.deepEqual(service.continuationCandidates(context, [candidate]), [candidate]);
  assert.deepEqual(service.continuationCandidates({ ...context, fallback: false }, [candidate]), []);
  assert.throws(() => service.continuationCandidates({ ...context, fallbackFrom: { runtime: 'claude-code' } }, [candidate]), { code: 'WORK_FALLBACK_UNSAFE' });
  assert.deepEqual(service.continuationCandidates(context, [{ ...candidate, runtime: 'claude-code' }]), [], 'incompatible CLI candidates must not prevent later safe native backups');
  for await (const _event of service.stream({ provider: { protocol: 'openai-chat', runtime: 'api', baseUrl: 'https://example.com', apiKey: 'fixture' }, model: { modelId: 'new' }, mode: 'work', messages: [{ role: 'user', content: '继续' }], context })) { /* consume */ }
  assert.equal(sent.resumeState.model, 'new'); assert.equal(sent.resumeState.protocol, 'openai-chat'); assert.equal(sent.resumeState.visibleText, '保存正文');
  store.run('DELETE FROM work_checkpoints');
  assert.throws(() => service.continuationCandidates(context, [candidate]), { code: 'WORK_FALLBACK_UNSAFE' });
});
