// Continuation is a new provider request with the already committed answer in
// context. It does not pretend that a provider's disconnected process survives.
export const continuationInstruction = 'The previous assistant response was interrupted. Continue the same answer exactly after its last saved character. Output only the missing continuation; do not repeat the beginning, recap, apologize, or reopen an existing Markdown code fence. Preserve the original language and formatting. In Work mode, use saved files and completed tool results; do not blindly repeat actions. If an earlier action has uncertain completion, inspect its result first.';

export function isContinuationRequest(text) {
  return typeof text === 'string' && /^(?:请\s*)?(?:继续(?:生成|输出|回答|写|完成)?|接着(?:写|输出|回答)|从断点继续|continue|resume)[。.!！\s]*$/i.test(text.trim());
}

// Remove only a sufficiently long, exact overlap at the start of a resumed
// stream. Semantic paraphrases cannot safely be removed by a string filter.
export function continuationAppender(previous) {
  if (!previous) return { push: text => text, finish: () => '' };
  const candidates = [previous];
  const tail = previous.slice(-4096);
  for (let i = 0; i < tail.length; i++) if ((i === 0 || tail[i - 1] === '\n') && tail.length - i >= 32) candidates.push(tail.slice(i));
  let buffer = '', resolved = false;
  const flush = () => {
    let overlap = 0;
    for (const candidate of candidates) if (candidate.length >= Math.min(32, previous.length) && buffer.startsWith(candidate)) overlap = Math.max(overlap, candidate.length);
    // Also recognize a cut in the middle of a sentence/code line.
    for (let size = Math.min(tail.length, buffer.length); size >= 32 && size > overlap; size--) if (tail.endsWith(buffer.slice(0, size))) { overlap = size; break; }
    const text = buffer.slice(overlap); buffer = ''; resolved = true; return text;
  };
  return {
    push(text) {
      if (resolved) return text;
      buffer += text;
      if (buffer.length < 32 || (buffer.length < 256 * 1024 && candidates.some(candidate => candidate.startsWith(buffer)))) return '';
      return flush();
    },
    finish: flush,
  };
}

export function modelCapacities(record) {
  const positive = (...values) => values.find(value => Number.isInteger(value) && value > 0) ?? null;
  const contextWindow = positive(record.contextWindow, record.context_window, record.context_length, record.max_context_length, record.limits?.context, record.top_provider?.context_length);
  const maxOutputTokens = positive(record.maxOutputTokens, record.max_output_tokens, record.max_completion_tokens, record.limits?.output, record.top_provider?.max_completion_tokens);
  return { contextWindow: contextWindow ? Math.min(contextWindow, 10_000_000) : null, maxOutputTokens: maxOutputTokens ? Math.min(maxOutputTokens, 1_000_000) : null };
}

export function estimateTokens(text) {
  // A capacity preflight, not billing or an exact provider tokenizer. Latin
  // prose tends to use fewer tokens per character than CJK and emoji.
  let ascii = 0, other = 0;
  for (const char of text) if (char.charCodeAt(0) < 128) ascii++; else other++;
  return Math.ceil(ascii / 3) + other * 2;
}

export function checkContext(messages, systemPrompt, candidates, outputLimit) {
  const estimate = estimateTokens(systemPrompt || '') + messages.reduce((sum, message) => sum + 12 + estimateTokens(message.content) + (message.attachments || []).reduce((n, file) => n + (file.kind === 'image' ? 4096 : estimateTokens(file.text || '')), 0), 0);
  const fits = candidate => !candidate.context_window || estimate + Math.min(outputLimit, candidate.max_output_tokens || outputLimit) <= candidate.context_window;
  return { estimate, compatible: candidates.filter(fits) };
}
