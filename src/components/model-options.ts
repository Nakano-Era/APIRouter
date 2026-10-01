import type { Model } from '../types';

export function groupModelOptions(models: Model[]) {
  const groups = new Map<string, { key: string; name: string; variants: Model[] }>();
  for (const model of models) {
    const key = model.routeKey || model.name;
    const group = groups.get(key) || { key, name: model.name, variants: [] };
    group.variants.push(model); groups.set(key, group);
  }
  return [...groups.values()];
}
