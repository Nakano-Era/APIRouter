import test from 'node:test';
import assert from 'node:assert/strict';
import { interrupted, mergeSnapshot, upsertMessage } from '../src/hooks/chat-state.ts';

const message = (id, content, status = 'streaming') => ({ id, role: 'assistant', content, status, attachments: [], createdAt: '2026-10-01' });

test('continuation meta updates the existing answer instead of adding another bubble', () => {
  const previous = [message('answer', '第一部分', 'error')];
  const resumed = upsertMessage(previous, message('answer', '第一部分'));
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].content, '第一部分');
  assert.equal(resumed[0].status, 'streaming');
});

test('late or partial snapshots cannot discard already displayed output', () => {
  const current = [message('answer', '第一部分，以及已经收到的第二部分')];
  const snapshot = mergeSnapshot(current, [message('answer', '第一部分', 'error')]);
  assert.equal(snapshot[0].content, current[0].content);
  assert.equal(snapshot[0].status, 'error');
  assert.equal(mergeSnapshot(current, [message('answer', current[0].content + '。完整结尾', 'complete')])[0].content, current[0].content + '。完整结尾');
});

test('a shorter user edit from another tab replaces the stale user text', () => {
  const previous = { ...message('user', '另一标签页编辑前的较长用户消息', 'complete'), role: 'user' };
  const edited = { ...previous, content: '较短编辑' };
  assert.equal(mergeSnapshot([previous], [edited])[0].content, '较短编辑');
  assert.equal(upsertMessage([previous], edited)[0].content, '较短编辑');
});

test('an older snapshot cannot discard a just-accepted reply', () => {
  const user = { ...message('user', '用户请求', 'complete'), role: 'user' };
  const current = [user, message('answer', '开始回答')];
  assert.deepEqual(mergeSnapshot(current, [user]), current);
});

test('disconnect preserves text and marks both empty and partial responses resumable', () => {
  for (const content of ['', '已生成一半']) {
    const result = interrupted([message('answer', content)]);
    assert.equal(result[0].content, content);
    assert.equal(result[0].canContinue, true);
    assert.equal(result[0].status, 'error');
  }
  assert.equal(interrupted([message('done', '已完成', 'complete')])[0].status, 'complete');
});

test('message updates leave unrelated chat snapshots untouched', () => {
  const first = [message('a', '对话 A')];
  const second = [message('b', '对话 B')];
  const result = upsertMessage(first, message('a', '对话 A 的续写'));
  assert.equal(result[0].content, '对话 A 的续写');
  assert.equal(first[0].content, '对话 A');
  assert.equal(second[0].content, '对话 B');
});
