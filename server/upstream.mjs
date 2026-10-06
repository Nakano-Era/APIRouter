import { openUpstream, readJson, UpstreamError, redactRawError, redactDiagnosticObject } from './net.mjs';
import { modelCapacities } from './continuation.mjs';
import { responsesProfile } from './responses-compat.mjs';
export { validateBaseUrl, sanitizeUpstreamError, UpstreamError } from './net.mjs';

const invalid = () => new UpstreamError('上游响应格式不符合所选协议，请检查 API 配置。', 'INVALID_UPSTREAM_RESPONSE');
const toolError = () => new UpstreamError('模型请求了工具调用，但当前站点未启用工具执行；本次任务未执行这些操作。', 'UNSUPPORTED_TOOL_CALL');
const outputLimit = () => new UpstreamError('回复达到本次输出上限，已保存内容，可继续生成。', 'OUTPUT_LIMIT_REACHED');
const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
const hasToolType = type => /tool|function_call|computer|web_search|file_search|code_interpreter|image_generation|mcp_|shell|apply_patch/.test(type ?? '');

export async function listModels(provider, { signal } = {}) {
  const models = new Map();
  const seenCursors = new Set();
  let cursor;
  for (let page = 0; page < 20; page++) {
    const request = await openUpstream(provider, 'models', {
      signal, timeoutMs: 30_000,
      query: provider.protocol === 'anthropic' ? { limit: 1000, ...(cursor ? { after_id: cursor } : {}) } : undefined,
    });
    try {
      const result = await readJson(request.response);
      if (result?.error) throw new UpstreamError('上游模型列表请求失败，请检查 API Key 和协议；也可以手动添加模型。', 'UPSTREAM_MODEL_LIST_ERROR');
      const entries = Array.isArray(result) ? result : result?.data;
      if (!Array.isArray(entries)) throw invalid();
      for (const item of entries) {
        const id = typeof item === 'string' ? item : item?.id;
        if (typeof id !== 'string' || !id.trim() || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) continue;
        const name = item?.display_name || item?.name || id;
        const capacity = modelCapacities(typeof item === 'object' ? item : {});
        models.set(id, { modelId: id, name: typeof name === 'string' ? name.slice(0, 512) : id, ...(capacity.contextWindow ? { contextWindow: capacity.contextWindow } : {}), ...(capacity.maxOutputTokens ? { maxOutputTokens: capacity.maxOutputTokens } : {}) });
      }
      if (models.size > 10_000) throw new UpstreamError('上游模型列表过大，请改为手动添加需要的模型。', 'UPSTREAM_RESPONSE_TOO_LARGE');
      if (provider.protocol !== 'anthropic' || !result.has_more) return [...models.values()];
      cursor = result.last_id;
      if (typeof cursor !== 'string' || !cursor || seenCursors.has(cursor)) throw invalid();
      seenCursors.add(cursor);
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      if (error instanceof UpstreamError) {
        if (error.rawDiagnostic) error.rawDiagnostic = redactDiagnosticObject(error.rawDiagnostic, provider.apiKey);
        throw error;
      }
      throw new UpstreamError('读取上游模型列表失败，请稍后重试。', 'UPSTREAM_CONNECTION_ERROR');
    } finally { await request.cleanup(); }
  }
  throw new UpstreamError('上游模型列表分页过多，请手动添加需要的模型。', 'UPSTREAM_RESPONSE_TOO_LARGE');
}

function prepareMessages(messages, model, protocol) {
  if (!Array.isArray(messages) || !messages.length) throw new UpstreamError('消息不能为空。', 'INVALID_MESSAGES', 400);
  return messages.map(message => {
    if (!['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
      throw new UpstreamError('消息角色或内容格式无效。', 'INVALID_MESSAGES', 400);
    }
    const blocks = [];
    const textBlock = text => protocol === 'anthropic' || protocol === 'openai-chat'
      ? { type: 'text', text }
      : { type: message.role === 'assistant' ? 'output_text' : 'input_text', text };
    if (message.content) blocks.push(textBlock(message.content));
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind === 'image') {
        if (!model.vision) throw new UpstreamError('当前模型未启用图片输入，请选择支持图片的模型。', 'VISION_UNSUPPORTED', 400);
        if (message.role !== 'user') throw new UpstreamError('图片只能作为用户输入发送。', 'INVALID_ATTACHMENT', 400);
        const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(attachment.dataUrl ?? '');
        if (!match || (attachment.mime && match[1] !== attachment.mime)) throw new UpstreamError('图片附件格式无效。', 'INVALID_ATTACHMENT', 400);
        blocks.push(protocol === 'anthropic'
          ? { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
          : protocol === 'openai-responses'
            ? { type: 'input_image', image_url: attachment.dataUrl, detail: 'auto' }
            : { type: 'image_url', image_url: { url: attachment.dataUrl } });
      } else if (['text', 'archive', 'file'].includes(attachment.kind) && typeof attachment.text === 'string') {
        blocks.push(textBlock(`\n<attachment name=${JSON.stringify(attachment.name ?? 'file')}>\n${attachment.text}\n</attachment>`));
      } else throw new UpstreamError('附件内容未解析，无法发送给模型。', 'INVALID_ATTACHMENT', 400);
    }
    if (!blocks.length) blocks.push(textBlock(''));
    return { role: message.role, content: protocol === 'openai-chat' && blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks };
  });
}

function requestBody({ provider, model, messages, maxOutputTokens, systemPrompt, effort = 'auto' }) {
  if (!model?.modelId || typeof model.modelId !== 'string') throw new UpstreamError('请选择有效模型。', 'INVALID_MODEL', 400);
  const limit = Number.isInteger(maxOutputTokens) && maxOutputTokens > 0 ? Math.min(maxOutputTokens, 128_000) : 4096;
  const input = prepareMessages(messages, model, provider.protocol);
  if (!['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new UpstreamError('思考强度无效。', 'INVALID_EFFORT', 400);
  if (provider.protocol === 'anthropic') return {
    model: model.modelId, messages: input, max_tokens: limit, stream: true,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    ...(effort !== 'auto' ? { output_config: { effort } } : {}),
  };
  if (provider.protocol === 'openai-responses') return {
    model: model.modelId, input, max_output_tokens: limit, stream: true, store: false,
    ...(systemPrompt ? { instructions: systemPrompt } : {}),
    ...(effort !== 'auto' ? { reasoning: { effort } } : {}),
  };
  return {
    model: model.modelId,
    messages: [...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []), ...input],
    max_completion_tokens: limit, stream: true, stream_options: { include_usage: true },
    ...(effort !== 'auto' ? { reasoning_effort: effort } : {}),
  };
}

async function* sseEvents(body, touch = () => {}) {
  if (!body) throw invalid();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let data = [];
  let event = '';
  let frameSize = 0;
  let totalSize = 0;
  function processLine(line) {
    if (!line) {
      const result = data.length ? { event, data: data.join('\n') } : null;
      data = []; event = ''; frameSize = 0;
      return result;
    }
    frameSize += line.length;
    if (frameSize > 1024 * 1024) throw new UpstreamError('上游单条事件过大。', 'UPSTREAM_RESPONSE_TOO_LARGE');
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    if (line.startsWith('event:')) event = line.slice(6).trim();
    return null;
  }
  for await (const chunk of body) {
    touch();
    totalSize += chunk.length;
    if (totalSize > 32 * 1024 * 1024) throw new UpstreamError('上游响应过大，已停止生成。', 'UPSTREAM_RESPONSE_TOO_LARGE');
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r\n|\r|\n/.exec(buffer))) {
      // Keep a trailing CR until the next chunk so CRLF cannot become two newlines.
      if (match[0] === '\r' && match.index === buffer.length - 1) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const parsed = processLine(line);
      if (parsed) yield parsed;
    }
    if (buffer.length > 1024 * 1024) throw new UpstreamError('上游单条事件过大。', 'UPSTREAM_RESPONSE_TOO_LARGE');
  }
  buffer += decoder.decode();
  // Handle a final complete event without the optional blank delimiter.
  for (const line of buffer.split(/\r\n|\r|\n/)) {
    const parsed = processLine(line);
    if (parsed) yield parsed;
  }
  const final = processLine('');
  if (final) yield final;
}

const outputEvent = (type, text) => {
  if (text == null) return [];
  if (typeof text !== 'string') throw invalid();
  return text ? [{ type, text }] : [];
};

function chatContent(content) {
  if (typeof content === 'string') return outputEvent('delta', content);
  if (content == null) return [];
  if (!Array.isArray(content)) throw invalid();
  return content.flatMap(part => {
    if (part?.type === 'text') return outputEvent('delta', part.text);
    if (part?.type === 'refusal') return outputEvent('delta', part.refusal);
    if (part?.type === 'thinking') return outputEvent('reasoning', part.thinking ?? part.text);
    if (['reasoning', 'reasoning_text', 'reasoning_content'].includes(part?.type)) return outputEvent('reasoning', part.text ?? part.reasoning);
    if (['redacted_thinking', 'encrypted_reasoning', 'signature'].includes(part?.type)) return [];
    throw new UpstreamError('上游返回了当前界面不支持的非文本内容。', 'UNSUPPORTED_OUTPUT');
  });
}

function chatOutput(message = {}) {
  // These are provider extensions, not text inferred from the answer itself.
  const reasoning = message.reasoning_content ?? message.reasoning;
  const events = outputEvent('reasoning', reasoning);
  const content = chatContent(message.content);
  events.push(...content);
  if (!content.some(event => event.type === 'delta')) events.push(...outputEvent('delta', message.refusal));
  return events;
}

function anthropicContent(content) {
  if (!Array.isArray(content)) throw invalid();
  return content.flatMap(part => {
    if (hasToolType(part?.type)) throw toolError();
    if (part?.type === 'text') return outputEvent('delta', part.text);
    if (part?.type === 'thinking') return outputEvent('reasoning', part.thinking);
    if (part?.type === 'redacted_thinking') return [];
    throw new UpstreamError('上游返回了当前界面不支持的非文本内容。', 'UNSUPPORTED_OUTPUT');
  });
}

function responsesOutput({ deferPhase = false } = {}) {
  const states = new Set(), byId = new Map(), byIndex = new Map(), anonymous = new Map();
  const stateFor = (data = {}, item = {}, kind = item.type ?? 'message') => {
    const id = item.id ?? data.item_id;
    const index = Number.isInteger(data.output_index) ? data.output_index : undefined;
    let state = (id ? byId.get(id) : undefined) ?? (index !== undefined ? byIndex.get(index) : undefined);
    if (!state) {
      state = anonymous.get(kind);
      if (state && (id || index !== undefined)) anonymous.delete(kind);
    }
    if (!state) { state = { parts: new Map(), phase: undefined, settled: false }; states.add(state); }
    if (id) byId.set(id, state);
    if (index !== undefined) byIndex.set(index, state);
    if (!id && index === undefined) anonymous.set(kind, state);
    const phase = item.phase ?? data.phase;
    if (phase === 'commentary' || phase === 'final_answer') state.phase = phase;
    return state;
  };
  const write = (state, key, text, kind, snapshot = false) => {
    if (text == null) return;
    if (typeof text !== 'string') throw invalid();
    let part = state.parts.get(key);
    if (!part) { part = { text: '', emitted: 0, kind }; state.parts.set(key, part); }
    // done/completed carry complete snapshots. Only their unseen suffix is new.
    if (!snapshot) part.text += text;
    else if (text.startsWith(part.text)) part.text = text;
  };
  const drain = state => {
    const events = [];
    for (const part of state.parts.values()) {
      if (deferPhase && part.kind === 'message' && !state.phase && !state.settled) continue;
      const type = part.kind === 'reasoning' || state.phase === 'commentary' ? 'reasoning' : 'delta';
      events.push(...outputEvent(type, part.text.slice(part.emitted)));
      part.emitted = part.text.length;
    }
    return events;
  };
  const messagePart = (state, part, index) => {
    if (part?.type === 'output_text') write(state, `message:${index}`, part.text, 'message', true);
    else if (part?.type === 'refusal') write(state, `message:${index}`, part.refusal, 'message', true);
    else throw new UpstreamError('上游返回了当前界面不支持的非文本内容。', 'UNSUPPORTED_OUTPUT');
  };
  const itemSnapshot = (item, data, settled) => {
    if (hasToolType(item?.type)) throw toolError();
    const state = stateFor(data, item);
    if (settled) state.settled = true;
    if (item?.type === 'reasoning') {
      if ((item.summary != null && !Array.isArray(item.summary)) || (item.content != null && !Array.isArray(item.content))) throw invalid();
      for (const [index, part] of (item.summary ?? []).entries()) {
        if (part?.type === 'summary_text') write(state, `summary:${index}`, part.text, 'reasoning', true);
      }
      for (const [index, part] of (item.content ?? []).entries()) {
        if (part?.type === 'reasoning_text' || part?.type === 'text') write(state, `reasoning:${index}`, part.text, 'reasoning', true);
      }
      // encrypted_content and signatures are deliberately never rendered.
    } else if (item?.type === 'message') {
      if (!Array.isArray(item.content)) throw invalid();
      item.content.forEach((part, index) => messagePart(state, part, index));
    } else {
      throw new UpstreamError('上游返回了当前界面不支持的非文本内容。', 'UNSUPPORTED_OUTPUT');
    }
    return drain(state);
  };
  const flush = () => [...states].flatMap(state => { state.settled = true; return drain(state); });
  return {
    flush,
    complete(output) {
      const events = Array.isArray(output)
        ? output.flatMap((item, index) => itemSnapshot(item, { output_index: index }, true)) : [];
      return [...events, ...flush()];
    },
    event(type, data) {
      if (hasToolType(type) || hasToolType(data.item?.type)) throw toolError();
      if (type === 'response.output_item.added' || type === 'response.output_item.done') {
        return itemSnapshot(data.item, data, type.endsWith('.done'));
      }
      if (/^response\.reasoning_(summary_text|text)\.(delta|done)$/.test(type)) {
        const state = stateFor(data, {}, 'reasoning');
        const summary = type.includes('summary_text');
        write(state, `${summary ? 'summary' : 'reasoning'}:${(summary ? data.summary_index : data.content_index) ?? 0}`,
          type.endsWith('.delta') ? data.delta : data.text, 'reasoning', type.endsWith('.done'));
        return drain(state);
      }
      if (type === 'response.reasoning_summary_part.added' || type === 'response.reasoning_summary_part.done') {
        const state = stateFor(data, {}, 'reasoning');
        if (data.part?.type === 'summary_text') write(state, `summary:${data.summary_index ?? 0}`, data.part.text, 'reasoning', true);
        return drain(state);
      }
      if (/^response\.(output_text|refusal)\.(delta|done)$/.test(type)) {
        const state = stateFor(data);
        write(state, `message:${data.content_index ?? 0}`, type.endsWith('.delta') ? data.delta : data.text ?? data.refusal,
          'message', type.endsWith('.done'));
        // Codex phase may first appear on output_item.done. Standard streams stay live.
        return drain(state);
      }
      if (type === 'response.content_part.added' || type === 'response.content_part.done') {
        const state = stateFor(data);
        messagePart(state, data.part, data.content_index ?? 0);
        return drain(state);
      }
      return [];
    },
  };
}

function checkStop(reason) {
  if (reason === 'tool_calls' || reason === 'function_call' || reason === 'tool_use' || reason === 'pause_turn') throw toolError();
  if (reason === 'length' || reason === 'max_tokens' || reason === 'max_output_tokens') throw outputLimit();
  if (reason === 'content_filter') throw new UpstreamError('上游内容过滤中断了回复。', 'UPSTREAM_CONTENT_FILTER');
}

function extractJson(result, protocol, responses = responsesOutput()) {
  if (!result || (result.error && !(protocol === 'openai-responses' && Array.isArray(result.output)))) throw new UpstreamError('上游返回了错误响应，请检查 API 配置或稍后重试。', 'UPSTREAM_RESPONSE_ERROR');
  let events = [], error;
  const stop = reason => { try { checkStop(reason); } catch (caught) { error = caught; } };
  let usage = result.usage;
  if (protocol === 'openai-chat') {
    const choice = result.choices?.[0];
    if (!choice?.message) throw invalid();
    if (choice.message.tool_calls?.length || choice.message.function_call) throw toolError();
    stop(choice.finish_reason);
    events = chatOutput(choice.message);
  } else if (protocol === 'openai-responses') {
    if (result.error || result.status === 'failed' || result.status === 'cancelled') error = new UpstreamError('上游未完成回复。', 'UPSTREAM_RESPONSE_ERROR');
    if (result.status === 'incomplete') {
      stop(result.incomplete_details?.reason);
      error ||= new UpstreamError('上游回复未完成，可继续生成。', 'UPSTREAM_INCOMPLETE');
    }
    events = responses.complete(result.output);
  } else {
    if (!Array.isArray(result.content)) throw invalid();
    stop(result.stop_reason);
    events = anthropicContent(result.content);
  }
  return { events, usage, error };
}

function normalizedUsage(usage, protocol) {
  return {
    type: 'usage',
    inputTokens: protocol === 'openai-chat' ? number(usage?.prompt_tokens)
      : number(usage?.input_tokens) + (protocol === 'anthropic' ? number(usage?.cache_creation_input_tokens) + number(usage?.cache_read_input_tokens) : 0),
    outputTokens: number(protocol === 'openai-chat' ? usage?.completion_tokens : usage?.output_tokens),
  };
}

export async function* streamReply(options) {
  const { provider, signal } = options;
  const body = requestBody(options);
  const endpoint = provider.protocol === 'anthropic' ? 'messages' : provider.protocol === 'openai-responses' ? 'responses' : 'chat/completions';
  const request = await openUpstream(provider, endpoint, { signal, body, diagnostics: options.diagnostics === true, idleTimeout: true, sessionId: options.context?.chatId });
  let finished = false;
  let emittedText = false;
  let usage;
  let lastPayload;
  const responses = responsesOutput({ deferPhase: responsesProfile(provider) === 'codex' });
  const redactedBlocks = new Set();
  const chatEmitted = { delta: '', reasoning: '' };
  try {
    if (!(request.response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
      lastPayload = await readJson(request.response, 16 * 1024 * 1024);
      const result = extractJson(lastPayload, provider.protocol);
      for (const event of result.events) {
        if (event.type === 'delta') emittedText = true;
        yield event;
      }
      if (result.usage) yield normalizedUsage(result.usage, provider.protocol);
      if (result.error) throw result.error;
      if (!emittedText) throw new UpstreamError('模型没有返回可显示的文本；可能仅返回推理或不支持的内容。', 'EMPTY_UPSTREAM_OUTPUT');
      return;
    }
    for await (const event of sseEvents(request.response.body, request.touch)) {
      lastPayload = event.data;
      if (event.data.trim() === '[DONE]') {
        if (provider.protocol === 'openai-chat') { finished = true; break; }
        continue;
      }
      let data;
      try { data = JSON.parse(event.data); } catch { throw invalid(); }
      if (!data || typeof data !== 'object') throw invalid();
      if (data.error || data.type === 'error' || event.event === 'error') {
        throw new UpstreamError('上游在生成过程中返回错误，回复可能不完整。', 'UPSTREAM_STREAM_ERROR');
      }
      let outputs = [], terminalError;
      if (provider.protocol === 'openai-chat') {
        if (data.usage) usage = data.usage;
        const choice = data.choices?.find(choice => choice.index === 0) ?? data.choices?.[0];
        if (choice) {
          if (choice.delta?.tool_calls?.length || choice.delta?.function_call || choice.message?.tool_calls?.length || choice.message?.function_call) throw toolError();
          try { checkStop(choice.finish_reason); } catch (error) { terminalError = error; }
          if (choice.finish_reason) finished = true;
          const isSnapshot = !choice.delta && choice.message;
          const extracted = chatOutput(choice.delta ?? choice.message);
          if (isSnapshot) {
            for (const type of ['reasoning', 'delta']) {
              const text = extracted.filter(event => event.type === type).map(event => event.text).join('');
              if (text.startsWith(chatEmitted[type])) outputs.push(...outputEvent(type, text.slice(chatEmitted[type].length)));
            }
          } else outputs = extracted;
          for (const output of outputs) chatEmitted[output.type] += output.text;
        }
      } else if (provider.protocol === 'openai-responses') {
        const type = data.type ?? event.event;
        outputs = responses.event(type, data);
        if (type === 'response.failed') {
          const final = extractJson(data.response || { status: 'failed' }, provider.protocol, responses);
          outputs.push(...final.events);
          usage = final.usage;
          terminalError = new UpstreamError('上游生成失败，已保存的内容可以继续生成。', 'UPSTREAM_STREAM_ERROR');
        }
        if (type === 'response.incomplete') {
          const final = extractJson(data.response || { status: 'incomplete' }, provider.protocol, responses);
          outputs.push(...final.events);
          usage = final.usage;
          terminalError = final.error || new UpstreamError('上游回复未完成，可以继续生成。', 'UPSTREAM_INCOMPLETE');
        }
        if (type === 'response.completed') {
          const final = extractJson(data.response, provider.protocol, responses);
          terminalError = final.error;
          outputs.push(...final.events);
          usage = final.usage;
          finished = true;
        }
      } else {
        const type = data.type ?? event.event;
        if (type === 'message_start') {
          usage = data.message?.usage;
          if (Array.isArray(data.message?.content)) outputs.push(...anthropicContent(data.message.content));
        }
        if (type === 'content_block_start') {
          if (hasToolType(data.content_block?.type)) throw toolError();
          if (data.content_block?.type === 'redacted_thinking') redactedBlocks.add(data.index);
          if (data.content_block?.type === 'text') outputs.push(...outputEvent('delta', data.content_block.text));
          if (data.content_block?.type === 'thinking') outputs.push(...outputEvent('reasoning', data.content_block.thinking));
        }
        if (type === 'content_block_delta') {
          if (data.delta?.type === 'input_json_delta') throw toolError();
          if (data.delta?.type === 'text_delta') outputs.push(...outputEvent('delta', data.delta.text));
          if (data.delta?.type === 'thinking_delta' && !redactedBlocks.has(data.index)) outputs.push(...outputEvent('reasoning', data.delta.thinking));
        }
        if (type === 'message_delta') {
          if (data.usage) usage = { ...usage, ...data.usage };
          checkStop(data.delta?.stop_reason);
        }
        if (type === 'message_stop') finished = true;
      }
      for (const output of outputs) {
        if (output.type === 'delta') emittedText = true;
        yield output;
      }
      if (terminalError) throw terminalError;
      if (finished && provider.protocol !== 'openai-chat') break;
    }
    for (const output of responses.flush()) {
      if (output.type === 'delta') emittedText = true;
      yield output;
    }
    if (!finished) throw new UpstreamError('上游连接提前结束，已保存的内容可以继续生成。', 'UPSTREAM_TRUNCATED_STREAM');
    if (!emittedText) throw new UpstreamError('模型没有返回可显示的文本；可能仅返回推理或不支持的内容。', 'EMPTY_UPSTREAM_OUTPUT');
    if (usage) yield normalizedUsage(usage, provider.protocol);
  } catch (error) {
    // A dropped Codex stream can leave a message waiting for its phase metadata.
    // Preserve it as ordinary text instead of discarding already received output.
    yield* responses.flush();
    if (usage) yield normalizedUsage(usage, provider.protocol);
    if (request.signal.aborted) throw request.signal.reason;
    if (error instanceof UpstreamError) {
      if (error.rawDiagnostic) error.rawDiagnostic = redactDiagnosticObject(error.rawDiagnostic, provider.apiKey);
      if (lastPayload !== undefined) {
        const raw = typeof lastPayload === 'string' ? lastPayload : JSON.stringify(lastPayload);
        error.rawDiagnostic = { status: request.response.status, method: 'POST', protocol: provider.protocol,
          modelId: options.model.modelId, url: redactRawError(request.response.url, provider.apiKey), headers: {},
          body: redactRawError(raw.slice(0, 1024 * 1024), provider.apiKey), truncated: raw.length > 1024 * 1024,
          readNote: '生成结束前最后一条上游响应。' };
      }
      throw error;
    }
    throw new UpstreamError('读取上游响应失败，回复可能不完整，请稍后重试。', 'UPSTREAM_CONNECTION_ERROR');
  } finally { await request.cleanup(); }
}
