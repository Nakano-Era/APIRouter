import test from 'node:test';
import assert from 'node:assert/strict';
import { remapChatModel, resolveAvailableModelId, selectModelId } from '../src/hooks/model-selection.ts';

const models = [{ id: 'default' }, { id: 'renamed-high' }, { id: 'renamed-regular' }];
const aliases = { 'old-high': 'renamed-high', 'old-regular': 'renamed-regular', 'earliest-high': 'renamed-high' };

test('catalog refresh retains the selected renamed version instead of switching to the default', () => {
  assert.equal(selectModelId(models, aliases, 'old-high', 'default'), 'renamed-high');
  assert.equal(selectModelId(models, aliases, 'old-regular', 'default'), 'renamed-regular');
  assert.equal(selectModelId(models, aliases, 'earliest-high', 'default'), 'renamed-high');
  assert.equal(selectModelId(models, aliases, 'renamed-high', 'default'), 'renamed-high');
});

test('opening a historical chat prefers its mapped model over the current draft model', () => {
  assert.equal(selectModelId(models, aliases, 'old-high', 'renamed-regular'), 'renamed-high');
  const original = { id: 'chat-a', modelId: 'old-high', mode: 'work', effort: 'max' };
  const mapped = remapChatModel(original, models, aliases);
  assert.deepEqual(mapped, { ...original, modelId: 'renamed-high' });
  assert.equal(original.modelId, 'old-high');
});

test('stale chat snapshots are remapped while unrelated and unavailable history stays unchanged', () => {
  const snapshots = [{ modelId: 'old-high' }, { modelId: 'old-regular' }, { modelId: 'default' }, { modelId: 'deleted-model' }];
  const updated = snapshots.map(chat => remapChatModel(chat, models, aliases));
  assert.deepEqual(updated.map(chat => chat.modelId), ['renamed-high', 'renamed-regular', 'default', 'deleted-model']);
  assert.equal(updated[2], snapshots[2]);
  assert.equal(updated[3], snapshots[3]);
});

test('aliases cannot select a target excluded by access or mode filtering', () => {
  const permitted = [models[0], models[2]];
  assert.equal(resolveAvailableModelId('old-high', permitted, aliases), null);
  assert.equal(selectModelId(permitted, aliases, 'old-high', 'old-regular'), 'renamed-regular');
  assert.equal(selectModelId(permitted, aliases, 'old-high', 'also-unavailable'), 'default');
  assert.equal(remapChatModel({ modelId: 'old-high' }, permitted, aliases).modelId, 'old-high');
});

test('older servers, empty catalogs, and missing aliases retain normal selection fallback', () => {
  assert.equal(selectModelId(models, {}, 'renamed-regular', 'default'), 'renamed-regular');
  assert.equal(selectModelId(models, {}, 'missing', 'renamed-regular'), 'renamed-regular');
  assert.equal(selectModelId(models, {}, undefined, null), 'default');
  assert.equal(selectModelId([], aliases, 'old-high', 'default'), '');
  assert.equal(resolveAvailableModelId('toString', models, {}), null);
});
