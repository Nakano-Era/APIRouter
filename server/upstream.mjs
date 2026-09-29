import { openUpstream, readJson, UpstreamError } from './net.mjs';
export { validateBaseUrl, sanitizeUpstreamError, UpstreamError } from './net.mjs';

const invalid = () => new UpstreamError('上游响应格式不符合所选协议，请检查 API 配置。', 'INVALID_UPSTREAM_RESPONSE');
const toolError = () => new UpstreamError('模型请求了工具调用，但当前站点未启用工具执行；本次任务未执行这些操作。', 'UNSUPPORTED_TOOL_CALL');
const outputLimit = () => new UpstreamError('回复达到输出上限，内容可能不完整。可提高上限后重新生成。', 'OUTPUT_LIMIT_REACHED');
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
        models.set(id, { modelId: id, name: typeof name === 'string' ? name.slice(0, 512) : id });
      }
      if (models.size > 10_000) throw new UpstreamError('上游模型列表过大，请改为手动添加需要的模型。', 'UPSTREAM_RESPONSE_TOO_LARGE');
      if (provider.protocol !== 'anthropic' || !result.has_more) return [...models.values()];
      cursor = result.last_id;
      if (typeof cursor !== 'string' || !cursor || seenCursors.has(cursor)) throw invalid();
      seenCursors.add(cursor);
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      if (error instanceof UpstreamError) throw error;
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
      } else if (attachment.kind === 'text' && typeof attachment.text === 'string') {
        blocks.push(textBlock(`\n<attachment name=${JSON.stringify(attachment.name ?? 'file')}>\n${attachment.text}\n</attachment>`));
      } else throw new UpstreamError('附件内容未解析，无法发送给模型。', 'INVALID_ATTACHMENT', 400);
    }
    if (!blocks.length) blocks.push(textBlock(''));
    return { role: message.role, content: protocol === 'openai-chat' && blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks };
  });
}

function requestBody({ provider, model, messages, maxOutputTokens, systemPrompt }) {
  if (!model?.modelId || typeof model.modelId !== 'string') throw new UpstreamError('请选择有效模型。', 'INVALID_MODEL', 400);
  const limit = Number.isInteger(maxOutputTokens) && maxOutputTokens > 0 ? Math.min(maxOutputTokens, 128_000) : 4096;
  const input = prepareMessages(messages, model, provider.protocol);
  if (provider.protocol === 'anthropic') return {
    model: model.modelId, messages: input, max_tokens: limit, stream: true,
    ...(systemPrompt ? { system: systemPrompt } : {}),
  };
  if (provider.protocol === 'openai-responses') return {
    model: model.modelId, input, max_output_tokens: limit, stream: true, store: false,
    ...(systemPrompt ? { instructions: systemPrompt } : {}),
  };
  return {
    model: model.modelId,
    messages: [...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []), ...input],
    max_completion_tokens: limit, stream: true, stream_options: { include_usage: true },
  };
}

async function* sseEvents(body) {
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

function chatText(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) throw invalid();
  return content.map(part => {
    if (part.type === 'text' && typeof part.text === 'string') return part.text;
    if (part.type === 'refusal' && typeof part.refusal === 'string') return part.refusal;
    throw new UpstreamError('上游返回了当前界面不支持的非文本内容。', 'UNSUPPORTED_OUTPUT');
  }).join('');
}

function responseText(output) {
  if (!Array.isArray(output)) return '';
  return output.map(item => {
    if (hasToolType(item.type)) throw toolError();
    if (item.type === 'reasoning') return '';
    if (item.type !== 'message') throw new UpstreamError('上游返回了当前界面不支持的输出类型。', 'UNSUPPORTED_OUTPUT');
    if (!Array.isArray(item.content)) throw invalid();
    return item.content.map(part => {
      if (part.type === 'output_text' && typeof part.text === 'string') return part.text;
      if (part.type === 'refusal' && typeof part.refusal === 'string') return part.refusal;
      throw new UpstreamError('上游返回了当前界面不支持的非文本内容。', 'UNSUPPORTED_OUTPUT');
    }).join('');
  }).join('');
}

function checkStop(reason) {
  if (reason === 'tool_calls' || reason === 'function_call' || reason === 'tool_use' || reason === 'pause_turn') throw toolError();
  if (reason === 'length' || reason === 'max_tokens' || reason === 'max_output_tokens') throw outputLimit();
  if (reason === 'content_filter') throw new UpstreamError('上游内容过滤中断了回复。', 'UPSTREAM_CONTENT_FILTER');
}

function extractJson(result, protocol) {
  if (!result || result.error) throw new UpstreamError('上游返回了错误响应，请检查 API 配置或稍后重试。', 'UPSTREAM_RESPONSE_ERROR');
  let text = '';
  let usage = result.usage;
  if (protocol === 'openai-chat') {
    const choice = result.choices?.[0];
    if (!choice?.message) throw invalid();
    if (choice.message.tool_calls?.length || choice.message.function_call) throw toolError();
    checkStop(choice.finish_reason);
    text = chatText(choice.message.content) || choice.message.refusal || '';
  } else if (protocol === 'openai-responses') {
    if (result.status === 'failed' || result.status === 'cancelled') throw new UpstreamError('上游未完成回复。', 'UPSTREAM_RESPONSE_ERROR');
    if (result.status === 'incomplete') {
      checkStop(result.incomplete_details?.reason);
      throw new UpstreamError('上游回复未完成。', 'UPSTREAM_INCOMPLETE');
    }
    text = responseText(result.output);
  } else {
    if (!Array.isArray(result.content)) throw invalid();
    checkStop(result.stop_reason);
    text = result.content.map(part => {
      if (hasToolType(part.type)) throw toolError();
      if (part.type === 'text') return part.text ?? '';
      if (part.type === 'thinking' || part.type === 'redacted_thinking') return '';
      throw new UpstreamError('上游返回了当前界面不支持的非文本内容。', 'UNSUPPORTED_OUTPUT');
    }).join('');
  }
  return { text, usage };
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
  const request = await openUpstream(provider, endpoint, { signal, body });
  let finished = false;
  let emittedText = false;
  let usage;
  try {
    if (!(request.response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
      const result = extractJson(await readJson(request.response, 16 * 1024 * 1024), provider.protocol);
      if (!result.text) throw new UpstreamError('模型没有返回可显示的文本；可能仅返回推理或不支持的内容。', 'EMPTY_UPSTREAM_OUTPUT');
      yield { type: 'delta', text: result.text };
      if (result.usage) yield normalizedUsage(result.usage, provider.protocol);
      return;
    }
    for await (const event of sseEvents(request.response.body)) {
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
      let text = '';
      if (provider.protocol === 'openai-chat') {
        if (data.usage) usage = data.usage;
        const choice = data.choices?.find(choice => choice.index === 0) ?? data.choices?.[0];
        if (choice) {
          if (choice.delta?.tool_calls?.length || choice.delta?.function_call || choice.message?.tool_calls?.length) throw toolError();
          checkStop(choice.finish_reason);
          if (choice.finish_reason) finished = true;
          text = chatText(choice.delta?.content ?? choice.message?.content) || choice.delta?.refusal || '';
        }
      } else if (provider.protocol === 'openai-responses') {
        const type = data.type ?? event.event;
        if (hasToolType(type) || hasToolType(data.item?.type)) throw toolError();
        if (type === 'response.output_text.delta') text = data.delta ?? '';
        if (type === 'response.refusal.delta') text = data.delta ?? '';
        if (type === 'response.failed') throw new UpstreamError('上游生成失败，回复可能不完整。', 'UPSTREAM_STREAM_ERROR');
        if (type === 'response.incomplete') {
          checkStop(data.response?.incomplete_details?.reason);
          throw new UpstreamError('上游回复未完成。', 'UPSTREAM_INCOMPLETE');
        }
        if (type === 'response.completed') {
          const final = extractJson(data.response, provider.protocol);
          if (!emittedText) text = final.text;
          usage = final.usage;
          finished = true;
        }
      } else {
        const type = data.type ?? event.event;
        if (type === 'message_start') usage = data.message?.usage;
        if (type === 'content_block_start') {
          if (hasToolType(data.content_block?.type)) throw toolError();
          if (data.content_block?.type === 'text') text = data.content_block.text ?? '';
        }
        if (type === 'content_block_delta') {
          if (data.delta?.type === 'input_json_delta') throw toolError();
          if (data.delta?.type === 'text_delta') text = data.delta.text ?? '';
        }
        if (type === 'message_delta') {
          if (data.usage) usage = { ...usage, ...data.usage };
          checkStop(data.delta?.stop_reason);
        }
        if (type === 'message_stop') finished = true;
      }
      if (typeof text !== 'string') throw invalid();
      if (text) { emittedText = true; yield { type: 'delta', text }; }
      if (finished && provider.protocol !== 'openai-chat') break;
    }
    if (!finished) throw new UpstreamError('上游连接提前结束，回复可能不完整，请重新生成。', 'UPSTREAM_TRUNCATED_STREAM');
    if (!emittedText) throw new UpstreamError('模型没有返回可显示的文本；可能仅返回推理或不支持的内容。', 'EMPTY_UPSTREAM_OUTPUT');
    if (usage) yield normalizedUsage(usage, provider.protocol);
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason;
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError('读取上游响应失败，回复可能不完整，请稍后重试。', 'UPSTREAM_CONNECTION_ERROR');
  } finally { await request.cleanup(); }
}
