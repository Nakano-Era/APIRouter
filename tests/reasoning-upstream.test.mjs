import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { streamReply } from '../server/upstream.mjs';

const originalPrivate = process.env.ALLOW_PRIVATE_UPSTREAM;
before(() => { process.env.ALLOW_PRIVATE_UPSTREAM = 'true'; });
after(() => {
  if (originalPrivate === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM;
  else process.env.ALLOW_PRIVATE_UPSTREAM = originalPrivate;
});

const frame = data => `data: ${JSON.stringify(data)}\n\n`;
const reasoning = text => ({ type: 'reasoning', text });
const delta = text => ({ type: 'delta', text });
const message = (id, text, phase) => ({ id, type: 'message', ...(phase ? { phase } : {}), content: [{ type: 'output_text', text }] });
const summary = (id, text) => ({ id, type: 'reasoning', summary: [{ type: 'summary_text', text }], encrypted_content: 'encrypted-secret' });

async function mock(t, protocol, payload, { json = false, profile, handler } = {}) {
  const server = createServer(async (req, res) => {
    try {
      for await (const _ of req) {}
      res.setHeader('content-type', json ? 'application/json' : 'text/event-stream');
      if (handler) return await handler(res);
      res.end(json ? JSON.stringify(payload) : payload.map(frame).join(''));
    } catch (error) { res.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return {
    provider: { baseUrl: `http://127.0.0.1:${server.address().port}`, protocol, apiKey: 'test-key', ...(profile ? { responsesProfile: profile } : {}) },
    model: { modelId: 'mock-model' }, messages: [{ role: 'user', content: 'hello' }],
  };
}
async function collect(options) { const events = []; for await (const event of streamReply(options)) events.push(event); return events; }
const textOf = (events, type) => events.filter(event => event.type === type).map(event => event.text).join('');

for (const field of ['reasoning_content', 'reasoning']) {
  test(`chat JSON separates explicit ${field} from the answer`, async t => {
    const options = await mock(t, 'openai-chat', { choices: [{ message: { [field]: 'Visible reasoning.', content: 'Final answer.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 9 } }, { json: true });
    assert.deepEqual(await collect(options), [reasoning('Visible reasoning.'), delta('Final answer.'), { type: 'usage', inputTokens: 3, outputTokens: 9 }]);
  });
}

test('chat thinking content blocks stay separate without interpreting ordinary answer text', async t => {
  const options = await mock(t, 'openai-chat', { choices: [{ message: { content: [
    { type: 'thinking', thinking: 'Visible process.', signature: 'signature-secret' },
    { type: 'redacted_thinking', data: 'redacted-secret' },
    { type: 'encrypted_reasoning', text: 'encrypted-secret' },
    { type: 'signature', text: 'signature-secret' },
    { type: 'text', text: 'Let me think: this is ordinary answer text.' },
  ] }, finish_reason: 'stop' }] }, { json: true });
  assert.deepEqual(await collect(options), [reasoning('Visible process.'), delta('Let me think: this is ordinary answer text.')]);
});

test('chat streams reasoning incrementally and does not replay a final message snapshot', async t => {
  const options = await mock(t, 'openai-chat', [
    { choices: [{ index: 0, delta: { reasoning_content: 'Compare ' } }] },
    { choices: [{ index: 0, delta: { reasoning: 'the options.', content: 'Answer' } }] },
    { choices: [{ index: 0, message: { reasoning_content: 'Compare the options.', content: 'Answer.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 6 } },
  ]);
  assert.deepEqual(await collect(options), [reasoning('Compare '), reasoning('the options.'), delta('Answer'), delta('.'), { type: 'usage', inputTokens: 1, outputTokens: 6 }]);
});

test('Anthropic thinking block starts and deltas are visible while opaque blocks and signatures are not', async t => {
  const options = await mock(t, 'anthropic', [
    { type: 'message_start', message: { usage: { input_tokens: 2, cache_read_input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'First ', signature: 'signature-secret' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'step.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature-secret' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'redacted-secret' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'redacted-secret' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: 'Result' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '.' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
    { type: 'message_stop' },
  ]);
  assert.deepEqual(await collect(options), [reasoning('First '), reasoning('step.'), delta('Result'), delta('.'), { type: 'usage', inputTokens: 5, outputTokens: 8 }]);
});

test('Anthropic JSON retains public thinking without exposing signed or redacted content', async t => {
  const options = await mock(t, 'anthropic', { content: [
    { type: 'thinking', thinking: 'Visible summary.', signature: 'signature-secret' },
    { type: 'redacted_thinking', data: 'redacted-secret' },
    { type: 'text', text: 'Answer.' },
  ], stop_reason: 'end_turn' }, { json: true });
  assert.deepEqual(await collect(options), [reasoning('Visible summary.'), delta('Answer.')]);
});

test('Responses JSON separates summary, commentary and final_answer and ignores encrypted content', async t => {
  const options = await mock(t, 'openai-responses', { status: 'completed', output: [
    summary('r0', 'Summary.'),
    { id: 'r1', type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Visible reasoning.' }], encrypted_content: 'encrypted-secret' },
    message('m0', 'Checking data.', 'commentary'), message('m1', 'Final answer.', 'final_answer'),
  ] }, { json: true });
  assert.deepEqual(await collect(options), [reasoning('Summary.'), reasoning('Visible reasoning.'), reasoning('Checking data.'), delta('Final answer.')]);
});

test('Responses summary lifecycle emits each part once across delta, done, item and completed snapshots', async t => {
  const item = { ...summary('r0', 'Compare both.'), summary: [{ type: 'summary_text', text: 'Compare both.' }, { type: 'summary_text', text: 'Choose one.' }] };
  const options = await mock(t, 'openai-responses', [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, summary: [] } },
    { type: 'response.reasoning_summary_part.added', item_id: 'r0', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'r0', output_index: 0, summary_index: 0, delta: 'Compare ' },
    { type: 'response.reasoning_summary_text.done', item_id: 'r0', output_index: 0, summary_index: 0, text: 'Compare both.' },
    { type: 'response.reasoning_summary_part.done', item_id: 'r0', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: 'Compare both.' } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'r0', output_index: 0, summary_index: 1, delta: 'Choose one.' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { status: 'completed', output: [item, message('m0', 'Answer.')], usage: { input_tokens: 5, output_tokens: 10 } } },
  ]);
  assert.deepEqual(await collect(options), [reasoning('Compare '), reasoning('both.'), reasoning('Choose one.'), delta('Answer.'), { type: 'usage', inputTokens: 5, outputTokens: 10 }]);
});

test('Responses reasoning_text streams once and completed snapshots can supply unseen summary items', async t => {
  const options = await mock(t, 'openai-responses', [
    { type: 'response.reasoning_text.delta', item_id: 'r0', output_index: 0, content_index: 0, delta: 'Visible reasoning.' },
    { type: 'response.reasoning_text.done', item_id: 'r0', output_index: 0, content_index: 0, text: 'Visible reasoning.' },
    { type: 'response.completed', response: { status: 'completed', output: [
      { id: 'r0', type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Visible reasoning.' }] },
      summary('r1', 'Later summary.'), message('m0', 'Answer.'),
    ] } },
  ]);
  assert.deepEqual(await collect(options), [reasoning('Visible reasoning.'), reasoning('Later summary.'), delta('Answer.')]);
});

test('Responses explicit phases keep streamed commentary separate and final_answer in the body', async t => {
  const options = await mock(t, 'openai-responses', [
    { type: 'response.output_item.added', output_index: 0, item: message('m0', '', 'commentary') },
    { type: 'response.output_text.delta', item_id: 'm0', output_index: 0, content_index: 0, delta: 'Checking.' },
    { type: 'response.output_item.done', output_index: 0, item: message('m0', 'Checking.', 'commentary') },
    { type: 'response.output_item.added', output_index: 1, item: message('m1', '', 'final_answer') },
    { type: 'response.output_text.delta', item_id: 'm1', output_index: 1, content_index: 0, delta: 'The answer.' },
    { type: 'response.completed', response: { status: 'completed', output: [message('m0', 'Checking.', 'commentary'), message('m1', 'The answer.', 'final_answer')] } },
  ]);
  assert.deepEqual(await collect(options), [reasoning('Checking.'), delta('The answer.')]);
});

test('Codex phase arriving only on output_item.done still separates commentary from the answer', async t => {
  const options = await mock(t, 'openai-responses', [
    { type: 'response.output_item.added', output_index: 0, item: message('m0', '') },
    { type: 'response.output_text.delta', item_id: 'm0', output_index: 0, delta: 'Checking.' },
    { type: 'response.output_item.done', output_index: 0, item: message('m0', 'Checking.', 'commentary') },
    { type: 'response.output_text.delta', item_id: 'm1', output_index: 1, delta: 'Answer.' },
    { type: 'response.completed', response: { status: 'completed', output: [message('m0', 'Checking.', 'commentary'), message('m1', 'Answer.', 'final_answer')] } },
  ], { profile: 'codex' });
  assert.deepEqual(await collect(options), [reasoning('Checking.'), delta('Answer.')]);
});

test('standard Responses without phase keep emitting live text before completion', { timeout: 3000 }, async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const options = await mock(t, 'openai-responses', [], { handler: async res => {
    res.write(frame({ type: 'response.output_text.delta', item_id: 'm0', output_index: 0, delta: 'Live text.' }));
    await gate;
    res.end(frame({ type: 'response.completed', response: { status: 'completed', output: [message('m0', 'Live text.')] } }));
  } });
  const iterator = streamReply(options);
  try {
    const first = await iterator.next();
    assert.deepEqual(first.value, delta('Live text.'));
    release();
    assert.equal((await iterator.next()).done, true);
  } finally { release(); await iterator.return(); }
});

test('keyless compatible Responses reasoning deltas are not replayed by the completion snapshot', async t => {
  const options = await mock(t, 'openai-responses', [
    { type: 'response.reasoning_summary_text.delta', delta: 'Summary.' },
    { type: 'response.output_text.delta', delta: 'Answer.' },
    { type: 'response.completed', response: { status: 'completed', output: [summary('r0', 'Summary.'), message('m0', 'Answer.')] } },
  ]);
  assert.deepEqual(await collect(options), [reasoning('Summary.'), delta('Answer.')]);
});

for (const [protocol, payload] of [
  ['openai-chat', [{ choices: [{ delta: { reasoning_content: 'Saved reasoning.' } }], usage: { prompt_tokens: 2, completion_tokens: 4 } }]],
  ['anthropic', [{ type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 4 } } }, { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Saved reasoning.' } }]],
  ['openai-responses', [{ type: 'response.reasoning_summary_text.delta', item_id: 'r0', output_index: 0, summary_index: 0, delta: 'Saved reasoning.' }]],
]) {
  test(`${protocol} preserves reasoning before a truncated-stream error`, async t => {
    const options = await mock(t, protocol, payload);
    const events = [];
    await assert.rejects(async () => { for await (const event of streamReply(options)) events.push(event); }, { code: 'UPSTREAM_TRUNCATED_STREAM' });
    assert.equal(textOf(events, 'reasoning'), 'Saved reasoning.');
    assert.equal(textOf(events, 'delta'), '');
    if (protocol !== 'openai-responses') assert.deepEqual(events.at(-1), { type: 'usage', inputTokens: 2, outputTokens: 4 });
  });
}

test('Responses incomplete snapshots preserve streamed reasoning, partial answer and usage without duplication', async t => {
  const options = await mock(t, 'openai-responses', [
    { type: 'response.reasoning_summary_text.delta', item_id: 'r0', output_index: 0, summary_index: 0, delta: 'Summary.' },
    { type: 'response.output_text.delta', item_id: 'm0', output_index: 1, delta: 'Partial' },
    { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [summary('r0', 'Summary.'), message('m0', 'Partial answer')], usage: { input_tokens: 7, output_tokens: 12 } } },
  ]);
  const events = [];
  await assert.rejects(async () => { for await (const event of streamReply(options)) events.push(event); }, { code: 'OUTPUT_LIMIT_REACHED' });
  assert.deepEqual(events, [reasoning('Summary.'), delta('Partial'), delta(' answer'), { type: 'usage', inputTokens: 7, outputTokens: 12 }]);
});

test('reasoning-only completed JSON keeps visible reasoning but does not claim a completed answer', async t => {
  const options = await mock(t, 'openai-responses', { status: 'completed', output: [summary('r0', 'Only a summary.')] }, { json: true });
  const events = [];
  await assert.rejects(async () => { for await (const event of streamReply(options)) events.push(event); }, { code: 'EMPTY_UPSTREAM_OUTPUT' });
  assert.deepEqual(events, [reasoning('Only a summary.')]);
});

for (const errored of [false, true]) {
  test(`Codex unclassified partial text is retained as body on ${errored ? 'error' : 'EOF'}`, async t => {
    const options = await mock(t, 'openai-responses', [
      { type: 'response.reasoning_summary_text.delta', item_id: 'r0', output_index: 0, summary_index: 0, delta: 'Visible summary.' },
      { type: 'response.output_text.delta', item_id: 'm0', output_index: 1, delta: 'Unclassified partial text.' },
      ...(errored ? [{ type: 'error', error: { message: 'disconnected' } }] : []),
    ], { profile: 'codex' });
    const events = [];
    await assert.rejects(async () => { for await (const event of streamReply(options)) events.push(event); }, { code: errored ? 'UPSTREAM_STREAM_ERROR' : 'UPSTREAM_TRUNCATED_STREAM' });
    assert.deepEqual(events, [reasoning('Visible summary.'), delta('Unclassified partial text.')]);
  });
}
