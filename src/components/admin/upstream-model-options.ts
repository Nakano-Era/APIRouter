import type { AdminModel, Provider } from '../../types';

export function orderedProviders(providers: Provider[]) {
  return [...providers].sort((left, right) => Number(right.enabled) - Number(left.enabled)
    || (right.priority ?? 0) - (left.priority ?? 0));
}

export function upstreamModelGroups(models: AdminModel[], providers: Provider[], query = '', providerId = '') {
  const providerById = new Map(providers.map(provider => [provider.id, provider]));
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const rank = (model: AdminModel) => {
    const provider = providerById.get(model.providerId);
    return (provider?.enabled ? 0 : 4) + (model.enabled ? 0 : 2) + (model.available === false ? 1 : 0);
  };
  // Filter individual channel records before grouping, so a channel-name match
  // never brings unrelated sibling channels back into the results.
  const matched = models.filter(model => {
    if (providerId && model.providerId !== providerId) return false;
    const provider = providerById.get(model.providerId);
    const searchable = [model.name, model.modelId, model.routeKey, model.variantName,
      provider?.name || model.providerName].filter(Boolean).join(' ').toLocaleLowerCase();
    return terms.every(term => searchable.includes(term));
  }).sort((left, right) => rank(left) - rank(right)
    || (providerById.get(right.providerId)?.priority ?? 0) - (providerById.get(left.providerId)?.priority ?? 0));
  const groups = new Map<string, AdminModel[]>();
  for (const model of matched) {
    const key = model.routeKey || model.modelId;
    const channels = groups.get(key) || [];
    channels.push(model); groups.set(key, channels);
  }
  return [...groups].map(([key, channels]) => ({ key, channels, representative: channels[0] }));
}
