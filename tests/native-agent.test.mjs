import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNativeAgent, nativeResponse, nativeRequest, nativeTools } from '../runner/native-agent.mjs';
import { executeNativeTool } from '../runner/native-tools.mjs';

const jobFor = protocol => ({ mode: 'work', protocol, model: 'test-model', prompt: 'Create output/result.txt and describe it.', systemPrompt: '', effort: 'auto', maxOutputTokens: 8192, webSearch: false, skills: [], images: [], gateway: 'http://gateway:3210/proxy/' + 'a'.repeat(32), jobToken: 'local-ephemeral-token', limits: { maxTurns: 6 } });
const sse = (rows, split = false) => {
  const encoded = new TextEncoder().encode(rows.map(row => `data: ${typeof row === 'string' ? row : JSON.stringify(row)}\n\n`).join(''));
  return new Response(new ReadableStream({ start(controller) { if (split) for (let i = 0; i < encoded.length; i++) controller.enqueue(encoded.slice(i, i + 1)); else controller.enqueue(encoded); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
};
const chatText = (text, reason = 'stop') => sse([{ choices: [{ delta: { content: text }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: reason }] }, '[DONE]']);
const chatCall = (name = 'write_file', args = { path: 'output/result.txt', content: '你好' }, id = 'call_1') => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]']);
async function workspace(t) { const dir = await mkdtemp(join(tmpdir(), 'apirouter-native-')); t.after(() => rm(dir, { recursive: true, force: true })); await mkdir(join(dir, 'output')); return dir; }

test('native Chat tool loop writes real file and sends native tool results without credentials in checkpoints', async t => {
  const cwd = await workspace(t), requests = [], events = [];
  await runNativeAgent(jobFor('openai-chat'), { cwd, emit: event => events.push(event), fetcher: async (url, options) => {
    requests.push({ url, ...JSON.parse(options.body) });
    return requests.length === 1 ? chatCall() : chatText('文件已保存。');
  } });
  assert.equal(await readFile(join(cwd, 'output/result.txt'), 'utf8'), '你好');
  assert.equal(requests[1].messages.at(-1).role, 'tool');
  assert.equal(JSON.parse(requests[1].messages.at(-1).content).written, true);
  assert.equal(events.filter(row => row.type === 'delta').map(row => row.text).join(''), '文件已保存。');
  const snapshots = events.filter(row => row.type === 'checkpoint').map(row => row.state);
  assert.ok(snapshots.some(state => state.journal[0]?.status === 'pending'));
  assert.equal(snapshots.at(-1).journal[0].status, 'completed');
  assert.equal(snapshots.at(-1).completed, true);
  assert.ok(!JSON.stringify(snapshots).includes('local-ephemeral-token'));
});

test('Anthropic split UTF-8 stream keeps tool input and tool_result format', async t => {
  const cwd = await workspace(t), requests = [];
  const tool = [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '开始写入。' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_1', name: 'write_file', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"output/result.txt","content":"测试' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '🙂"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ];
  const events = [];
  await runNativeAgent(jobFor('anthropic'), { cwd, emit: event => events.push(event), fetcher: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return requests.length === 1 ? sse(tool, true) : new Response(JSON.stringify({ content: [{ type: 'text', text: '完成' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 3 } }), { headers: { 'Content-Type': 'application/json' } });
  } });
  assert.equal(await readFile(join(cwd, 'output/result.txt'), 'utf8'), '测试🙂');
  assert.equal(requests[1].messages.at(-1).content[0].type, 'tool_result');
  assert.equal(requests[1].messages.at(-1).content[0].tool_use_id, 'tool_1');
  assert.equal(events.filter(row => row.type === 'delta').map(row => row.text).join(''), '开始写入。完成');
});

test('Responses loop preserves reasoning and function output as native input', async t => {
  const cwd = await workspace(t), requests = [];
  const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'write_file', arguments: '{"path":"output/result.txt","content":"response result"}' };
  await runNativeAgent(jobFor('openai-responses'), { cwd, fetcher: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return requests.length === 1 ? sse([
      { type: 'response.output_item.added', output_index: 1, item: { ...item, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: item.arguments },
      { type: 'response.output_item.done', output_index: 1, item },
      { type: 'response.completed', response: { output: [{ type: 'reasoning', id: 'rs_1', summary: [] }, item], usage: { input_tokens: 20, output_tokens: 10 } } },
    ]) : sse([{ type: 'response.output_text.delta', delta: 'Done.' }, { type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }] } }]);
  } });
  assert.equal(requests[1].store, false);
  assert.equal(requests[1].input.at(-1).type, 'function_call_output');
  assert.equal(requests[1].input.at(-1).call_id, 'call_1');
  assert.equal(requests[1].input.at(-3).type, 'reasoning');
  assert.equal(await readFile(join(cwd, 'output/result.txt'), 'utf8'), 'response result');
});

test('EOF and output limits remain resumable, including exact visible suffix after worker crash', async t => {
  const cwd = await workspace(t);
  for (const reason of ['eof', 'length']) {
    const events = [], job = jobFor('openai-chat');
    await assert.rejects(runNativeAgent(job, { cwd, emit: event => events.push(event), fetcher: async () => reason === 'eof' ? sse([{ choices: [{ delta: { content: '第一段未完成' } }] }]) : chatText('第一段未完成', 'length') }), { code: reason === 'eof' ? 'UPSTREAM_STREAM_INTERRUPTED' : 'UPSTREAM_OUTPUT_LIMIT' });
    const state = events.filter(event => event.type === 'checkpoint').at(-1).state;
    assert.equal(state.partial.text, '第一段未完成');
    const requests = [], resumed = [];
    await runNativeAgent({ ...job, resumeState: state, resumeText: '第一段未完成，随后断开' }, { cwd, emit: event => resumed.push(event), fetcher: async (_url, options) => { requests.push(JSON.parse(options.body)); return chatText('，接续完成。'); } });
    assert.equal(requests[0].messages.at(-2).content, '第一段未完成，随后断开');
    assert.match(requests[0].messages.at(-1).content, /without repeating/);
    assert.equal(resumed.filter(row => row.type === 'delta').map(row => row.text).join(''), '，接续完成。');
  }
});

test('resume does not repeat completed writes and marks interrupted side effects uncertain', async t => {
  const cwd = await workspace(t), job = jobFor('openai-chat'), events = [];
  let count = 0;
  await assert.rejects(runNativeAgent(job, { cwd, emit: event => events.push(event), fetcher: async () => ++count === 1 ? chatCall() : sse([{ choices: [{ delta: { content: '已写入' } }] }]) }), { code: 'UPSTREAM_STREAM_INTERRUPTED' });
  const last = events.filter(event => event.type === 'checkpoint').at(-1).state;
  await writeFile(join(cwd, 'output/result.txt'), 'external revision');
  await runNativeAgent({ ...job, resumeState: last }, { cwd, fetcher: async () => chatText('继续完成。') });
  assert.equal(await readFile(join(cwd, 'output/result.txt'), 'utf8'), 'external revision');
  const pending = events.find(event => event.type === 'checkpoint' && event.state.journal[0]?.status === 'pending').state;
  let request;
  await runNativeAgent({ ...job, resumeState: pending }, { cwd, fetcher: async (_url, options) => { request = JSON.parse(options.body); return chatText('需要先检查已有文件。'); } });
  assert.equal(JSON.parse(request.messages.at(-1).content).uncertain, true);
  assert.equal(await readFile(join(cwd, 'output/result.txt'), 'utf8'), 'external revision');
});

test('checkpoints are awaited before side effects and unknown tool errors reach the model', async t => {
  const cwd = await workspace(t), job = jobFor('openai-chat'); let acknowledged = false, count = 0;
  await runNativeAgent(job, { cwd, emit: async event => { if (event.type === 'checkpoint' && event.state.journal[0]?.status === 'pending') { await new Promise(resolve => setTimeout(resolve, 5)); acknowledged = true; } if (event.type === 'activity') assert.equal(acknowledged, true); }, fetcher: async (_url, options) => {
    if (++count === 1) return chatCall('unknown_tool', {});
    assert.match(JSON.parse(JSON.parse(options.body).messages.at(-1).content).error, /Unknown tool/);
    return chatText('工具不可用。');
  } });
});

test('file tools reject escapes, bound reads, load selected skills and execute commands', async t => {
  const cwd = await workspace(t);
  await assert.rejects(executeNativeTool('write_file', { path: '../escape.txt', content: 'x' }, { cwd }), /escapes/);
  await executeNativeTool('write_file', { path: 'output/read.txt', content: 'abcdef' }, { cwd });
  assert.equal((await executeNativeTool('read_file', { path: 'output/read.txt', offset: 2, limit: 2 }, { cwd })).content, 'cd');
  const skill = await executeNativeTool('use_skill', { name: 'drawing' }, { cwd, skills: [{ name: 'drawing', content: 'Draw SVG.' }] });
  assert.equal(skill.instructions, 'Draw SVG.');
  await assert.rejects(executeNativeTool('use_skill', { name: 'missing' }, { cwd }), /not selected/);
  const command = await executeNativeTool('run_command', { command: 'node -e "process.stdout.write(\'sandbox-command\')"' }, { cwd });
  assert.equal(command.exitCode, 0); assert.equal(command.stdout, 'sandbox-command');
  try { await symlink(cwd, join(cwd, 'linked'), 'junction'); } catch (error) { if (error.code === 'EPERM') return; throw error; }
  await assert.rejects(executeNativeTool('write_file', { path: 'linked/escape.txt', content: 'x' }, { cwd }), /Symbolic links/);
});

test('native request respects selected output ceiling, effort and supported search protocol', () => {
  for (const protocol of ['anthropic', 'openai-chat', 'openai-responses']) {
    const job = { ...jobFor(protocol), effort: 'high', webSearch: true, maxOutputTokens: 65536 };
    const body = nativeRequest(job, [{ role: 'user', content: 'hello' }]);
    assert.equal(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens, 65536);
    assert.equal(body.output_config?.effort ?? body.reasoning_effort ?? body.reasoning?.effort, 'high');
    assert.equal(nativeTools(protocol, { webSearch: true }).some(tool => tool.name === 'web_search' || tool.type === 'web_search'), protocol !== 'openai-chat');
    assert.equal(nativeTools(protocol, { delegated: true }).some(tool => (tool.function?.name ?? tool.name) === 'delegate_task'), false);
  }
});

test('delegated subtask uses bounded shared turns and actual sandbox tools', async t => {
  const cwd = await workspace(t), requests = [];
  await runNativeAgent(jobFor('openai-chat'), { cwd, fetcher: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return chatCall('delegate_task', { task: 'Create a text file.' }, 'delegate_1');
    if (requests.length === 2) return chatCall('write_file', { path: 'output/child.txt', content: 'child-created' }, 'child_1');
    if (requests.length === 3) return chatText('Created output/child.txt.');
    assert.match(requests.at(-1).messages.at(-1).content, /Created output\/child.txt/);
    return chatText('子任务已完成。');
  } });
  assert.equal(await readFile(join(cwd, 'output/child.txt'), 'utf8'), 'child-created');
  assert.ok(!requests[1].tools.some(tool => tool.function.name === 'delegate_task'));
});

test('Responses incomplete and malformed tool arguments cannot execute side effects', async t => {
  const cwd = await workspace(t), events = [];
  await assert.rejects(nativeResponse(sse([{ type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, output: [] } }]), 'openai-responses'), { code: 'UPSTREAM_OUTPUT_LIMIT' });
  let count = 0;
  await runNativeAgent(jobFor('openai-chat'), { cwd, emit: event => events.push(event), fetcher: async () => ++count === 1 ? sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'bad', function: { name: 'write_file', arguments: '{"path":' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]']) : chatText('请重试。') });
  assert.match(events.filter(event => event.type === 'checkpoint').at(-1).state.journal[0].result.error, /JSON/);
  await assert.rejects(readFile(join(cwd, 'output/result.txt')), { code: 'ENOENT' });
});

test('native usage accumulates tool rounds and delegates, and resume starts a new invocation total', async t => {
  const cwd = await workspace(t), events = [], requests = [];
  const whole = (message, usage, finish_reason = 'stop') => new Response(JSON.stringify({ choices: [{ message, finish_reason }], usage }), { headers: { 'Content-Type': 'application/json' } });
  const tool = { role: 'assistant', content: null, tool_calls: [{ id: 'delegate_1', type: 'function', function: { name: 'delegate_task', arguments: '{"task":"Give a short summary."}' } }] };
  await runNativeAgent(jobFor('openai-chat'), { cwd, emit: event => events.push(event), fetcher: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return whole(tool, { prompt_tokens: 10, completion_tokens: 20 }, 'tool_calls');
    if (requests.length === 2) return whole({ role: 'assistant', content: 'Subtask result' }, { prompt_tokens: 30, completion_tokens: 40 });
    return whole({ role: 'assistant', content: 'Summary completed' }, { prompt_tokens: 50, completion_tokens: 60 });
  } });
  assert.deepEqual(events.filter(event => event.type === 'usage').map(({ inputTokens, outputTokens }) => [inputTokens, outputTokens]), [[10, 20], [40, 60], [90, 120]]);
  const state = events.filter(event => event.type === 'checkpoint').at(-1).state, resumed = [];
  await runNativeAgent({ ...jobFor('openai-chat'), resumeState: state, resumeText: state.visibleText }, { cwd, emit: event => resumed.push(event), fetcher: async () => whole({ role: 'assistant', content: 'Appendix' }, { prompt_tokens: 7, completion_tokens: 9 }) });
  assert.deepEqual(resumed.filter(event => event.type === 'usage').map(({ inputTokens, outputTokens }) => [inputTokens, outputTokens]), [[7, 9]]);
});

test('interrupted Anthropic response reports usage already delivered by upstream', async t => {
  const cwd = await workspace(t), events = [];
  await assert.rejects(runNativeAgent(jobFor('anthropic'), { cwd, emit: event => events.push(event), fetcher: async () => sse([
    { type: 'message_start', message: { usage: { input_tokens: 11, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Partial' } },
    { type: 'message_delta', delta: {}, usage: { output_tokens: 7 } },
    { type: 'error', error: { type: 'overloaded_error', message: 'Capacity reached' } },
  ]) }), { code: 'UPSTREAM_STREAM_ERROR' });
  assert.deepEqual(events.filter(event => event.type === 'usage').map(({ inputTokens, outputTokens }) => [inputTokens, outputTokens]), [[18, 7]]);
  assert.equal(events.filter(event => event.type === 'checkpoint').at(-1).state.partial.text, 'Partial');
});

test('resume canonicalizes a repeated prefix removed by the application', async t => {
  const cwd = await workspace(t), prefix = 'This already saved introduction is longer than thirty-two characters.\n';
  const state = { version: 1, protocol: 'openai-chat', model: 'test-model', history: [{ role: 'user', content: 'Write a report' }, { role: 'assistant', content: prefix }, { role: 'user', content: 'Continue' }], journal: [], pendingCalls: [], partial: { text: prefix + 'new section', visibleStart: prefix.length }, visibleText: prefix + prefix + 'new section', completed: false };
  let request; const events = [];
  await runNativeAgent({ ...jobFor('openai-chat'), resumeState: state, resumeText: prefix + 'new section' }, { cwd, emit: event => events.push(event), fetcher: async (_url, options) => { request = JSON.parse(options.body); return chatText(' continued'); } });
  assert.equal(request.messages.at(-2).content, 'new section');
  assert.equal(events.filter(event => event.type === 'checkpoint').at(-1).state.visibleText, prefix + 'new section continued');
  const behind = { ...state, partial: { text: 'uncommitted tail', visibleStart: prefix.length }, visibleText: prefix + 'uncommitted tail' };
  await runNativeAgent({ ...jobFor('openai-chat'), resumeState: behind, resumeText: prefix }, { cwd, fetcher: async (_url, options) => { request = JSON.parse(options.body); return chatText(' actual tail'); } });
  assert.ok(!JSON.stringify(request.messages).includes('uncommitted tail'));
});

test('recovered queued calls with no pending record are uncertain, not automatically replayed', async t => {
  const cwd = await workspace(t), events = []; let requests = 0;
  await runNativeAgent(jobFor('openai-chat'), { cwd, emit: event => events.push(event), fetcher: async () => ++requests === 1 ? chatCall() : chatText('Done') });
  const staged = events.find(event => event.type === 'checkpoint' && event.state.pendingCalls.length && !event.state.journal.length).state;
  await writeFile(join(cwd, 'output/result.txt'), 'preserve existing result');
  await runNativeAgent({ ...jobFor('openai-chat'), resumeState: staged }, { cwd, fetcher: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(JSON.parse(body.messages.at(-1).content).uncertain, true);
    return chatText('Inspect before proceeding.');
  } });
  assert.equal(await readFile(join(cwd, 'output/result.txt'), 'utf8'), 'preserve existing result');
});

test('empty success and duplicate tool ids are rejected rather than completing or repeating a tool', async () => {
  await assert.rejects(nativeResponse(chatText(''), 'openai-chat'), { code: 'EMPTY_UPSTREAM_OUTPUT' });
  await assert.rejects(nativeResponse(sse([{ choices: [{ delta: { tool_calls: [0, 1].map(index => ({ index, id: 'same-id', function: { name: 'write_file', arguments: '{}' } })) }, finish_reason: 'tool_calls' }] }, '[DONE]']), 'openai-chat'), { code: 'INVALID_TOOL_CALL' });
});

test('Chat reasoning is emitted separately and remains in tool history without entering saved answer text', async t => {
  const cwd = await workspace(t), events = [], requests = [];
  await runNativeAgent(jobFor('openai-chat'), { cwd, emit: event => events.push(event), fetcher: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return sse([
      { choices: [{ delta: { reasoning_content: '先检查工作区。' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'inspect', function: { name: 'list_files', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ], true);
    return sse([{ choices: [{ delta: { reasoning: '检查完成。', content: '这是正文。' }, finish_reason: 'stop' }] }, '[DONE]']);
  } });
  assert.equal(requests[1].messages.find(message => message.tool_calls)?.reasoning_content, '先检查工作区。');
  assert.equal(events.filter(event => event.type === 'reasoning').map(event => event.text).join(''), '先检查工作区。检查完成。');
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), '这是正文。');
  assert.equal(events.filter(event => event.type === 'checkpoint').at(-1).state.visibleText, '这是正文。');
});

test('Anthropic thinking is separated while signed blocks survive native tool history', async t => {
  const cwd = await workspace(t), events = [], requests = [];
  await runNativeAgent(jobFor('anthropic'), { cwd, emit: event => events.push(event), fetcher: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '计划：', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '读取文件。' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-content-retained' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'inspect', name: 'list_files', input: {} } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ]);
    return new Response(JSON.stringify({ content: [{ type: 'thinking', thinking: '完成检查。', signature: 'final-signature' }, { type: 'redacted_thinking', data: 'opaque-never-display' }, { type: 'text', text: '最终回答。' }], stop_reason: 'end_turn' }), { headers: { 'Content-Type': 'application/json' } });
  } });
  assert.deepEqual(requests[1].messages.at(-2).content[0], { type: 'thinking', thinking: '计划：读取文件。', signature: 'signed-content-retained' });
  assert.equal(events.filter(event => event.type === 'reasoning').map(event => event.text).join(''), '计划：读取文件。完成检查。');
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), '最终回答。');
  const state = events.filter(event => event.type === 'checkpoint').at(-1).state;
  assert.equal(state.visibleText, '最终回答。');
  assert.equal(state.history.at(-1).content[0].signature, 'final-signature');
});

test('Responses reasoning summaries and explicit commentary are folded once while final_answer remains正文', async t => {
  const cwd = await workspace(t), events = [];
  const reasoning = { type: 'reasoning', id: 'r1', summary: [{ type: 'summary_text', text: '推理摘要。' }], encrypted_content: 'opaque-never-display' };
  const commentary = { type: 'message', id: 'm1', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '正在准备文件。' }] };
  const final = { type: 'message', id: 'm2', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '最终结论。' }] };
  await runNativeAgent(jobFor('openai-responses'), { cwd, emit: event => events.push(event), fetcher: async () => sse([
    { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, summary: [] } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'r1', output_index: 0, summary_index: 0, delta: '推理' },
    { type: 'response.reasoning_summary_text.delta', item_id: 'r1', output_index: 0, summary_index: 0, delta: '摘要。' },
    { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: '推理摘要。' },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.added', output_index: 1, item: { ...commentary, content: [] } },
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '正在准备文件。' },
    { type: 'response.output_item.done', output_index: 1, item: commentary },
    { type: 'response.output_item.added', output_index: 2, item: { ...final, content: [] } },
    { type: 'response.output_text.delta', output_index: 2, content_index: 0, delta: '最终结论。' },
    { type: 'response.output_text.done', output_index: 2, content_index: 0, text: '最终结论。' },
    { type: 'response.output_item.done', output_index: 2, item: final },
    { type: 'response.completed', response: { output: [reasoning, commentary, final] } },
  ], true) });
  assert.equal(events.filter(event => event.type === 'reasoning').map(event => event.text).join(''), '推理摘要。正在准备文件。');
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), '最终结论。');
  const state = events.filter(event => event.type === 'checkpoint').at(-1).state;
  assert.equal(state.visibleText, '最终结论。');
  assert.deepEqual(state.history.slice(-3), [reasoning, commentary, final]);
});

test('complete Responses output separates commentary, reasoning summaries, and unmarked final prose', async () => {
  const thoughts = [], answer = [];
  await nativeResponse(new Response(JSON.stringify({ status: 'completed', output: [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Summary.' }] },
    { type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: 'Working.' }] },
    { type: 'message', content: [{ type: 'output_text', text: '先思考这个问题，答案是 42。' }] },
  ] }), { headers: { 'Content-Type': 'application/json' } }), 'openai-responses', { onReasoning: value => thoughts.push(value), onText: value => answer.push(value) });
  assert.equal(thoughts.join(''), 'Summary.Working.');
  assert.equal(answer.join(''), '先思考这个问题，答案是 42。');
});

test('interrupted reasoning never becomes resumable assistant answer text', async t => {
  const cwd = await workspace(t), events = [];
  await assert.rejects(runNativeAgent(jobFor('anthropic'), { cwd, emit: event => events.push(event), fetcher: async () => sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Only partial thinking' } },
  ]) }), { code: 'UPSTREAM_STREAM_INTERRUPTED' });
  const state = events.filter(event => event.type === 'checkpoint').at(-1).state;
  assert.equal(state.visibleText, ''); assert.equal(state.partial.text, '');
  let resumed;
  await runNativeAgent({ ...jobFor('anthropic'), resumeState: state, resumeText: '' }, { cwd, fetcher: async (_url, options) => { resumed = JSON.parse(options.body); return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Final answer' }], stop_reason: 'end_turn' }), { headers: { 'Content-Type': 'application/json' } }); } });
  assert.ok(!JSON.stringify(resumed.messages).includes('Only partial thinking'));
});

test('Codex late commentary phase is separated and late final_answer stays visible', async t => {
  const cwd = await workspace(t), events = [];
  const commentary = { type: 'message', id: 'c1', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '处理中。' }] };
  const final = { type: 'message', id: 'f1', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '答案。' }] };
  await runNativeAgent({ ...jobFor('openai-responses'), responsesProfile: 'codex' }, { cwd, emit: event => events.push(event), fetcher: async () => sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'c1', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, delta: '处理中。' },
    { type: 'response.output_item.done', output_index: 0, item: commentary },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'f1', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', output_index: 1, delta: '答案。' },
    { type: 'response.output_item.done', output_index: 1, item: final },
    { type: 'response.completed', response: { output: [commentary, final] } },
  ]) });
  assert.equal(events.filter(event => event.type === 'reasoning').map(event => event.text).join(''), '处理中。');
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), '答案。');
  assert.equal(events.filter(event => event.type === 'checkpoint').at(-1).state.visibleText, '答案。');
});

test('Codex failure before phase flushes unclassified output into resumable visible text', async t => {
  const cwd = await workspace(t), events = [];
  await assert.rejects(runNativeAgent({ ...jobFor('openai-responses'), responsesProfile: 'codex' }, { cwd, emit: event => events.push(event), fetcher: async () => sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, delta: '未确定phase的保留正文' },
  ]) }), { code: 'UPSTREAM_STREAM_INTERRUPTED' });
  assert.equal(events.filter(event => event.type === 'reasoning').length, 0);
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), '未确定phase的保留正文');
  const state = events.filter(event => event.type === 'checkpoint').at(-1).state;
  assert.equal(state.visibleText, '未确定phase的保留正文'); assert.equal(state.partial.text, '未确定phase的保留正文');
});

test('shortened terminal snapshots cannot rewind reasoning de-duplication', async () => {
  const reasoning = [];
  await nativeResponse(sse([
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Complete summary.' },
    { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'Complete' },
    { type: 'response.completed', response: { output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Complete summary.' }] }, { type: 'message', content: [{ type: 'output_text', text: 'Final' }] }] } },
  ]), 'openai-responses', { onReasoning: text => reasoning.push(text) });
  assert.equal(reasoning.join(''), 'Complete summary.');
});

test('Anthropic redacted thinking cannot leak through later mixed delta types', async () => {
  const reasoning = [], answer = [];
  const result = await nativeResponse(sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'encrypted-redaction' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'must-not-display-thought' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'must-not-display-answer' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: 'Visible summary.' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: 'Final answer.' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]), 'anthropic', { onReasoning: text => reasoning.push(text), onText: text => answer.push(text) });
  assert.equal(reasoning.join(''), 'Visible summary.'); assert.equal(answer.join(''), 'Final answer.');
  assert.deepEqual(result.output[0], { type: 'redacted_thinking', data: 'encrypted-redaction' });
});
