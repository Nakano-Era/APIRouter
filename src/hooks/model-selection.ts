import type { Model } from '../types';

export type ModelAliases = Record<string, string>;
type ModelOptions = ReadonlyArray<Pick<Model, 'id'>>;

// Alias destinations must still be available to this user and in the current mode.
export function resolveAvailableModelId(id: string | null | undefined, models: ModelOptions, aliases: ModelAliases): string | null {
  if (!id) return null;
  if (models.some(model => model.id === id)) return id;
  const destination = Object.hasOwn(aliases, id) ? aliases[id] : null;
  return destination && models.some(model => model.id === destination) ? destination : null;
}

export function selectModelId(models: ModelOptions, aliases: ModelAliases, ...preferences: Array<string | null | undefined>): string {
  for (const preference of preferences) {
    const available = resolveAvailableModelId(preference, models, aliases);
    if (available) return available;
  }
  return models[0]?.id || '';
}

export function remapChatModel<T extends { modelId: string }>(chat: T, models: ModelOptions, aliases: ModelAliases): T {
  const resolved = resolveAvailableModelId(chat.modelId, models, aliases);
  // Keep historical references when a model is unavailable; never rewrite them to a fallback.
  return resolved && resolved !== chat.modelId ? { ...chat, modelId: resolved } : chat;
}
