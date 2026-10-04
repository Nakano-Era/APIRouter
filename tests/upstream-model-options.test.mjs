import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedProviders, upstreamModelGroups } from '../src/components/admin/upstream-model-options.ts';

const providers = [
  { id: 'off', name: '停用渠道', enabled: false, priority: 999 },
  { id: 'any', name: 'AnyRouter', enabled: true, priority: 0 },
  { id: 'hub', name: 'AIHUB', enabled: true, priority: 10 },
];
const model = (id, providerId, routeKey = 'GPT', enabled = true) => ({ id, providerId, routeKey, modelId: 'gpt-upstream', name: routeKey, variantName: '', enabled, available: true });

test('searching a channel name excludes sibling channels under the same model', () => {
  const rows = [model('a', 'any'), model('h', 'hub'), model('o', 'off')];
  const result = upstreamModelGroups(rows, providers, '  aNyRoUtEr  ');
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].channels.map(row => row.id), ['a']);
  assert.equal(result[0].representative.providerId, 'any');
});

test('channel selection intersects with text search instead of restoring excluded records', () => {
  const rows = [model('a', 'any'), model('h', 'hub'), { ...model('c', 'any', 'Claude'), modelId: 'claude-upstream' }];
  assert.deepEqual(upstreamModelGroups(rows, providers, 'gpt', 'any').flatMap(group => group.channels.map(row => row.id)), ['a']);
  assert.deepEqual(upstreamModelGroups(rows, providers, 'AIHUB', 'any'), []);
  assert.deepEqual(upstreamModelGroups(rows, providers, '', 'missing'), []);
  assert.deepEqual(upstreamModelGroups(rows, providers, 'anyrouter claude', 'any').map(group => group.key), ['Claude']);
});

test('enabled channels and enabled model records sort first without mutating source arrays', () => {
  const rows = [model('off', 'off'), model('disabled', 'hub', 'GPT', false), model('any', 'any'), model('hub', 'hub')];
  assert.deepEqual(upstreamModelGroups(rows, providers)[0].channels.map(row => row.id), ['hub', 'any', 'disabled', 'off']);
  assert.deepEqual(rows.map(row => row.id), ['off', 'disabled', 'any', 'hub']);
  assert.deepEqual(orderedProviders(providers).map(provider => provider.id), ['hub', 'any', 'off']);
  assert.deepEqual(providers.map(provider => provider.id), ['off', 'any', 'hub']);
});

test('groups with usable enabled channels precede disabled-only groups and empty matches are omitted', () => {
  const rows = [model('off', 'off', '停用分组'), model('disabled', 'any', '禁用模型', false), model('active', 'any', '可用模型')];
  assert.deepEqual(upstreamModelGroups(rows, providers).map(group => group.key), ['可用模型', '禁用模型', '停用分组']);
  assert.deepEqual(upstreamModelGroups(rows, providers, 'unknown'), []);
});

test('model and version matches retain only matching channel records and use current provider names', () => {
  const rows = [{ ...model('a', 'any'), variantName: '高智商', providerName: '旧渠道名' }, { ...model('h', 'hub'), variantName: '普通' }];
  assert.deepEqual(upstreamModelGroups(rows, providers, '高智商')[0].channels.map(row => row.id), ['a']);
  assert.equal(upstreamModelGroups(rows, providers, 'gpt')[0].channels.length, 2);
  assert.deepEqual(upstreamModelGroups(rows, providers, '旧渠道名'), []);
});
