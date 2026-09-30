import test from 'node:test';
import assert from 'node:assert/strict';
import { reasoningSplitter } from '../server/reasoning.mjs';

const split = chunks => {
  const parser = reasoningSplitter();
  const events = chunks.flatMap(chunk => parser.push(chunk)).concat(parser.finish());
  return Object.fromEntries(['delta', 'reasoning'].map(type => [type, events.filter(event => event.type === type).map(event => event.text).join('')]));
};

test('leading thinking markers split across any chunk boundary stay out of the answer', () => {
  const text = ' \n<ThInKiNg>这是过程。\n下一步</ThInKiNg>你好。';
  for (let position = 0; position <= text.length; position++) {
    assert.deepEqual(split([text.slice(0, position), text.slice(position)]), { delta: '你好。', reasoning: '这是过程。\n下一步' });
  }
  assert.deepEqual(split([...text]), { delta: '你好。', reasoning: '这是过程。\n下一步' });
});

test('multiple leading reasoning blocks and an interrupted block preserve each byte', () => {
  assert.deepEqual(split(['<think>one</think><thinking>two</thinking>answer']), { delta: 'answer', reasoning: 'onetwo' });
  assert.deepEqual(split(['<think>unfinished</thi']), { delta: '', reasoning: 'unfinished</thi' });
});

test('ordinary prose and quoted tag examples remain answer text', () => {
  for (const content of ['这个问题很简单，我应该先解释。\n正式回答。', '```xml\n<think>example</think>\n```', 'Use <think> tags.', '`<think>` is a marker', '<thinking about this>', '<thi', '     plain']) {
    assert.deepEqual(split([...content]), { delta: content, reasoning: '' });
  }
});
