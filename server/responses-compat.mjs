import { createHash, randomUUID } from 'node:crypto';

export const responseProfiles = ['auto', 'standard', 'codex'];

export function responsesProfile(provider) {
  if (provider.protocol !== 'openai-responses') return 'standard';
  const selected = provider.responsesProfile ?? provider.responses_profile ?? 'auto';
  if (selected === 'standard' || selected === 'codex') return selected;
  try { return /(^|\.)anyrouter\.top$/i.test(new URL(provider.baseUrl).hostname) ? 'codex' : 'standard'; }
  catch { return 'standard'; }
}

// These are wire-format compatibility fields, not an installation of Codex CLI.
// Keep this adapter shared by ordinary chat, model tests and the sandbox broker.
export function prepareResponsesRequest(provider, body, { sessionId } = {}) {
  if (responsesProfile(provider) !== 'codex') return { body, headers: {}, profile: 'standard' };
  const session = sessionId ? createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 32) : randomUUID();
  const turn = randomUUID();
  const metadata = { session_id: session, thread_id: session, turn_id: turn };
  const input = Array.isArray(body.input) ? body.input.map(item => item?.role ? {
    type: 'message', ...item,
    content: typeof item.content === 'string' ? [{ type: item.role === 'assistant' ? 'output_text' : 'input_text', text: item.content }] : item.content,
  } : item) : body.input;
  const prepared = {
    ...body, input,
    instructions: body.instructions || 'You are a helpful assistant. Follow the user request and report tool results accurately.',
    stream: true, store: false,
    tools: body.tools ?? [], tool_choice: body.tool_choice ?? 'auto',
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    include: [...new Set([...(body.include ?? []), 'reasoning.encrypted_content'])],
    text: body.text ?? { verbosity: 'medium' },
    client_metadata: metadata, prompt_cache_key: session,
    ...(body.reasoning ? { reasoning: { ...body.reasoning, summary: body.reasoning.summary ?? 'auto' } } : {}),
  };
  // Codex subscription backends reject these otherwise-valid API parameters.
  // Standard Responses channels retain the configured per-response output cap.
  for (const key of ['max_output_tokens', 'max_tokens', 'temperature', 'top_p']) delete prepared[key];
  return { profile: 'codex', body: prepared, headers: {
    accept: 'text/event-stream', 'openai-beta': 'responses=experimental',
    'user-agent': 'codex_cli_rs/0.114.0 (APIRouter compatibility adapter)', originator: 'codex_cli_rs',
    'session-id': session, 'thread-id': session, 'x-client-request-id': turn,
  } };
}

// Administrators get a structural summary, never message text or tool arguments.
export function responseRequestShape(body, profile) {
  return { responsesProfile: profile, stream: body.stream, store: body.store,
    hasInstructions: !!body.instructions, inputItems: Array.isArray(body.input) ? body.input.length : 0,
    inputTypes: [...new Set((Array.isArray(body.input) ? body.input : []).map(item => item.type ?? item.role))],
    toolTypes: [...new Set((body.tools ?? []).map(tool => tool.type))],
    include: body.include ?? [], maxOutputTokens: body.max_output_tokens ?? null,
  };
}
