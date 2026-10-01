import test from 'node:test';
import assert from 'node:assert/strict';
import { groupModelOptions } from '../src/components/model-options.ts';
import { modelLimitKey, versionLimitOptions } from '../src/components/admin/model-limit-options.ts';

const model = (id, name, variantName = '', routeKey = name) => ({ id, name, variantName, routeKey, modelId: id, vision: false, modes: ['chat'], reasoningEfforts: ['auto'] });

test('model menu keeps distinct selectable version IDs under their parent', () => {
  const rows = [model('high-id', 'GPT', '高智商'), model('regular-id', 'GPT', '普通'), model('claude-id', 'Claude')];
  const groups = groupModelOptions(rows);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].variants.map(value => value.id), ['high-id', 'regular-id']);
  assert.deepEqual(groups[0].variants.map(value => value.variantName), ['高智商', '普通']);
  assert.equal(groups[1].variants[0].variantName, '');
});

test('legacy models without route metadata remain selectable', () => {
  const legacy = model('old-model', 'Existing Model'); delete legacy.routeKey; delete legacy.variantName;
  const groups = groupModelOptions([legacy]);
  assert.equal(groups[0].key, 'Existing Model');
  assert.equal(groups[0].variants[0].id, 'old-model');
});

test('identical display names do not merge distinct route groups', () => {
  const groups = groupModelOptions([model('a', 'Model', '普通', 'route-a'), model('b', 'Model', '普通', 'route-b')]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].variants[0].id, 'a');
  assert.equal(groups[1].variants[0].id, 'b');
});

test('model quota options stay independent for every version, including default', () => {
  const groups = [{ name: 'GPT', variants: [{ name: '高智商', modelIds: ['a'] }, { name: '普通', modelIds: ['b'] }, { name: '', modelIds: ['c'] }] }, { name: '草稿', variants: [] }];
  const limits = [{ routeKey: 'GPT', variantName: '普通', dailyLimit: 10, monthlyLimit: 100, usedToday: 2 }];
  const options = versionLimitOptions(groups, limits);
  assert.equal(options.length, 3);
  assert.equal(options.find(option => option.variantName === '普通').dailyLimit, 10);
  assert.equal(options.find(option => option.variantName === '高智商').dailyLimit, null);
  assert.equal(options.find(option => option.variantName === '').variantName, '');
  assert.ok(options.every(option => option.variantName !== null));
  assert.notEqual(modelLimitKey('GPT', '普通'), modelLimitKey('GPT', '高智商'));
});
