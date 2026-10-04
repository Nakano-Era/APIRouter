import { continuationInstruction } from './continuation.mjs';

export function executionTargets(mapping, model, effort) {
  return mapping ? [mapping, ...(mapping.fallbacks || [])].map(target => ({
    routeKey: target.targetRouteKey, variantName: target.targetVariantName || '', effort: target.effort || 'auto'
  })) : [{ routeKey: model.route_key, variantName: model.variant_name || '', effort }];
}

// Reuse the same answer boundary for every target. Previously saved text is
// context, never a second user request and never a new assistant message.
export function continuationMessages(base, content, continuing, resumed) {
  const messages = base.map(message => ({ ...message }));
  if (continuing && messages.at(-1)?.role === 'assistant') messages.at(-1).content = content;
  else if (content) messages.push({ role: 'assistant', content, attachments: [] });
  if (resumed) messages.push({ role: 'user', content: continuationInstruction, attachments: [] });
  return messages;
}

export function mayFallback(error, signal) {
  if (signal.aborted) return false;
  // A target failure can use the next configured target; local storage and
  // output safety ceilings cannot be solved by invoking another model.
  return !/^(?:ERR_)?SQLITE_/.test(error?.code || '') && !['WORK_STORAGE_FULL', 'WORK_ARTIFACT_COUNT_LIMIT', 'WORK_ARTIFACT_TOTAL_LIMIT', 'WORK_RESTORE_TOO_LARGE', 'WORK_EVENT_TOO_LARGE', 'WORK_FALLBACK_UNSAFE', 'WORK_CONTEXT_LIMIT', 'LOCAL_OUTPUT_LIMIT'].includes(error?.code);
}
