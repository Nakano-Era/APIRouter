import type { ModelGroup, ModelLimit } from '../../types';

export const modelLimitKey = (routeKey: string, variantName: string) => JSON.stringify([routeKey, variantName]);
export function versionLimitOptions(groups: ModelGroup[], limits: ModelLimit[]): ModelLimit[] {
  const options = new Map<string, ModelLimit>();
  for (const group of groups) for (const variant of group.variants) {
    options.set(modelLimitKey(group.name, variant.name), { routeKey: group.name, variantName: variant.name, dailyLimit: null, monthlyLimit: null });
  }
  for (const limit of limits) {
    const variantName = limit.variantName || '';
    options.set(modelLimitKey(limit.routeKey, variantName), { ...limit, variantName });
  }
  return [...options.values()];
}
