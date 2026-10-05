import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { streamReply, UpstreamError, sanitizeUpstreamError } from './upstream.mjs';
import { continuationAppender } from './continuation.mjs';
import { continuationMessages } from './generation-fallback.mjs';

const selection = `SELECT m.*,p.name AS provider_name,p.base_url,p.protocol,p.encrypted_key,
  p.priority,p.failure_threshold,p.cooldown_seconds,p.failure_protection_enabled AS provider_failure_protection_enabled,p.auth_mode,p.runtime,p.responses_profile,p.enabled AS provider_enabled
  FROM models m JOIN providers p ON p.id=m.provider_id`;
const nonChannelErrors = new Set([
  'INVALID_BASE_URL', 'BLOCKED_UPSTREAM_ADDRESS', 'INVALID_PROTOCOL', 'INVALID_AUTH_MODE',
  'MISSING_API_KEY', 'INVALID_MESSAGES', 'INVALID_ATTACHMENT', 'VISION_UNSUPPORTED',
  'INVALID_MODEL', 'INVALID_EFFORT', 'WORK_UNAVAILABLE', 'WORK_NOT_CONFIGURED', 'WORK_PROTOCOL_UNSUPPORTED',
  'WORK_FALLBACK_UNSAFE', 'WORK_CHECKPOINT_INCOMPATIBLE', 'WORK_CONTEXT_LIMIT', 'WORK_STORAGE_FULL',
  'WORK_ARTIFACT_COUNT_LIMIT', 'WORK_ARTIFACT_TOTAL_LIMIT', 'WORK_RESTORE_TOO_LARGE', 'WORK_EVENT_TOO_LARGE',
  'WORK_CHAT_NOT_FOUND', 'WORK_MESSAGE_NOT_FOUND', 'WORK_CHAT_BUSY', 'WEB_SEARCH_DISABLED', 'LOCAL_OUTPUT_LIMIT',
]);
const boundedInteger = (value, min, max, fallback) => Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;

function disposition(error, signal) {
  if (signal?.aborted) return { cancelled: true, channel: false, retry: false, switch: false };
  if (!(error instanceof UpstreamError) || nonChannelErrors.has(error.code)) return { channel: false, retry: false, switch: false };
  // The configured budget applies to every upstream failure, irrespective of
  // HTTP status, output already received, or whether a gateway retained progress.
  return { channel: true, retry: true, switch: true };
}

/** Route one logical reply only among administrator-defined equivalent model aliases. */
export function createRouter({ store, stream = streamReply, clock = Date.now, wait = sleep }) {
  const probes = new Set();
  const timestamp = () => new Date(clock()).toISOString();
  function readCandidate(modelId, routeKey, variantName, needsVision) {
    return store.get(`${selection} WHERE m.id=? AND m.route_key=? AND COALESCE(m.variant_name,'')=? AND m.enabled=1 AND m.available=1 AND p.enabled=1${needsVision ? ' AND m.vision=1' : ''}`, modelId, routeKey, variantName);
  }
  function cooldown(candidate) {
    if ((candidate.failure_protection_enabled ?? candidate.provider_failure_protection_enabled) === 0) return 'closed';
    if (!candidate.cooldown_until) return 'closed';
    const until = Date.parse(candidate.cooldown_until);
    // Corrupt persisted state is held closed to traffic until an admin resets it.
    if (!Number.isFinite(until) || until > clock()) return 'open';
    return 'half-open';
  }
  function recordFailure(candidate, error) {
    if ((candidate.failure_protection_enabled ?? candidate.provider_failure_protection_enabled) === 0) {
      return store.run("UPDATE models SET failure_count=failure_count+1,cooldown_until=NULL,status='error',error=?,last_checked_at=? WHERE id=? AND failure_epoch=?", sanitizeUpstreamError(error), timestamp(), candidate.id, candidate.failure_epoch);
    }
    // A recovery probe must reopen the circuit even if the admin raised its
    // threshold during the preceding cooldown.
    const threshold = candidate.cooldown_until ? 1 : boundedInteger(candidate.failure_threshold_override ?? candidate.failure_threshold, 1, 1000, 3);
    const seconds = boundedInteger(candidate.cooldown_seconds_override ?? candidate.cooldown_seconds, 1, 2_592_000, 60);
    return store.run(`UPDATE models SET failure_count=failure_count+1,status='error',error=?,last_checked_at=?,
      cooldown_until=CASE WHEN failure_count+1>=? THEN ? ELSE cooldown_until END,
      failure_epoch=failure_epoch+CASE WHEN failure_count+1>=? THEN 1 ELSE 0 END
      WHERE id=? AND failure_epoch=?`, sanitizeUpstreamError(error), timestamp(), threshold,
    new Date(clock() + seconds * 1000).toISOString(), threshold, candidate.id, candidate.failure_epoch);
  }
  function recordSuccess(candidate) {
    store.run(`UPDATE models SET failure_count=0,cooldown_until=NULL,status='ok',error=NULL,
      last_checked_at=?,failure_epoch=failure_epoch+1 WHERE id=? AND failure_epoch=?`, timestamp(), candidate.id, candidate.failure_epoch);
  }
  function auditStart(requestId, candidate, effort) {
    if (!requestId) return null;
    const auditId = randomUUID();
    store.run('INSERT INTO route_attempts(id,request_id,provider_id,model_id,outcome,error,created_at,execution_route_key,execution_variant_name,execution_effort) VALUES (?,?,?,?,?,?,?,?,?,?)',
      auditId, requestId, candidate.provider_id, candidate.id, 'running', null, timestamp(), candidate.route_key, candidate.variant_name || '', effort);
    return auditId;
  }
  function auditEnd(auditId, outcome, error) {
    if (auditId) {
      store.run('UPDATE route_attempts SET outcome=?,error=?,encrypted_detail=? WHERE id=?', outcome, error ? sanitizeUpstreamError(error) : null,
        error?.rawDiagnostic ? store.encrypt(JSON.stringify(error.rawDiagnostic)) : null, auditId);
      store.run('DELETE FROM route_attempts WHERE outcome<>? AND rowid NOT IN (SELECT rowid FROM route_attempts ORDER BY rowid DESC LIMIT 200)', 'running');
    }
  }

  async function* run({ routeKey, variantName = '', candidateIds, messages, maxOutputTokens, systemPrompt, signal, maxAttempts = 6, retriesPerChannel = 1, onAttempt, prepareAttempt, completeAttempt, attemptTimeoutMs, requestId, mode = 'chat', effort = 'auto', skillIds = [], webSearch = false, context }) {
    signal?.throwIfAborted();
    if (typeof routeKey !== 'string' || !routeKey.trim()) throw new UpstreamError('请选择有效的模型路由。', 'INVALID_ROUTE', 400);
    if (!Array.isArray(messages) || !messages.length) throw new UpstreamError('消息不能为空。', 'INVALID_MESSAGES', 400);
    const needsVision = messages.some(message => message.attachments?.some(attachment => attachment.kind === 'image'));
    const candidates = store.all(`${selection} WHERE m.route_key=? AND m.enabled=1 AND m.available=1 AND p.enabled=1${needsVision ? ' AND m.vision=1' : ''} ORDER BY p.priority DESC,m.id ASC`, routeKey)
      .filter(candidate => (candidate.variant_name || '') === variantName && (!candidateIds || candidateIds.includes(candidate.id)) && (effort === 'auto' || JSON.parse(candidate.reasoning_efforts || '[]').includes(effort)));
    if (!candidates.length) throw new UpstreamError(needsVision ? '该模型路由没有支持图片的可用通道。' : '该模型路由没有可用通道，请联系管理员。', needsVision ? 'VISION_UNSUPPORTED' : 'ROUTE_UNAVAILABLE', 400);
    const attemptLimit = boundedInteger(maxAttempts, 1, 100, 6);
    const defaultRetryLimit = boundedInteger(retriesPerChannel, 0, 3, 1);
    let attempts = 0, inheritedAttempts = 0;
    let lastError;
    let savedText = context?.resumeText || '', committedTools = !!context?.committedTools, previous;
    let knownInput = 0, knownOutput = 0;
    function accumulatedUsage(event) {
      const tokens = value => Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
      knownInput += tokens(event.inputTokens); knownOutput += tokens(event.outputTokens);
      return { type: 'usage', inputTokens: knownInput, outputTokens: knownOutput };
    }
    for (const initial of candidates) {
      signal?.throwIfAborted();
      let current = readCandidate(initial.id, routeKey, variantName, needsVision);
      if (!current || cooldown(current) === 'open' || probes.has(current.id)) continue;
      const explicitRetries = current.retries_override != null;
      if (!explicitRetries && inheritedAttempts >= attemptLimit) continue;
      const halfOpen = cooldown(current) === 'half-open';
      const retryLimit = explicitRetries ? boundedInteger(current.retries_override, 0, 100, defaultRetryLimit) : defaultRetryLimit;
      let ownFailureEpoch = null;
      if (halfOpen) probes.add(current.id);
      try {
        for (let retry = 0; retry <= (halfOpen && !explicitRetries ? 0 : retryLimit); retry++) {
          signal?.throwIfAborted();
          if (!explicitRetries && inheritedAttempts >= attemptLimit) break;
          current = readCandidate(initial.id, routeKey, variantName, needsVision);
          const ownCooldown = explicitRetries && ownFailureEpoch !== null && current?.failure_epoch === ownFailureEpoch;
          if (!current || (cooldown(current) === 'open' && !ownCooldown) || (!halfOpen && probes.has(current.id))) break;
          // Decryption and local configuration errors are not channel outages.
          const provider = {
            id: current.provider_id, name: current.provider_name, baseUrl: current.base_url,
            protocol: current.protocol, authMode: current.auth_mode ?? 'auto', runtime: current.runtime || 'api', responsesProfile: current.responses_profile || 'auto',
            apiKey: store.decrypt(current.encrypted_key),
          };
          const model = { id: current.id, modelId: current.model_id, vision: !!current.vision, contextWindow: current.context_window ?? null, maxOutputTokens: current.max_output_tokens ?? null };
          const selected = { type: 'selected', modelId: current.id, providerId: current.provider_id,
            providerName: current.provider_name, upstreamModelId: current.model_id };
          if (attempts > 0) yield { type: 'routing', message: retry > 0 ? '通道暂时无响应，正在重试。' : '当前通道不可用，正在切换同一模型的其他通道。' };
          await onAttempt?.({ ...selected, attempt: attempts + 1 });
          signal?.throwIfAborted();
          yield selected;
          signal?.throwIfAborted();
          attempts++;
          if (!explicitRetries) inheritedAttempts++;
          const auditId = auditStart(requestId, current, effort);
          let auditFinished = false;
          let attemptText = false, attemptMessages = messages, attemptContext = context;
          let appender;
          const attemptController = new AbortController();
          const attemptSignal = signal ? AbortSignal.any([signal, attemptController.signal]) : attemptController.signal;
          const timer = Number.isFinite(attemptTimeoutMs) && attemptTimeoutMs > 0
            ? setTimeout(() => attemptController.abort(new UpstreamError('上游响应超时，已保留进度。', 'UPSTREAM_TIMEOUT', 504)), attemptTimeoutMs) : null;
          const append = text => { if (!text) return null; attemptText = true; savedText += text; return { type: 'delta', text }; };
          let pendingUsage;
          try {
            if (attempts > 1) {
              const changedChannel = previous?.id !== current.id;
              attemptContext = { ...context, continuation: true, fallback: !!context?.fallback || changedChannel, committedTools, fallbackFrom: previous, resumeText: savedText };
              attemptMessages = savedText || committedTools ? continuationMessages(messages, savedText, false, true) : messages;
              const prepared = await prepareAttempt?.({ previous, candidate: { ...selected, runtime: provider.runtime, protocol: provider.protocol }, context: attemptContext, messages: attemptMessages, error: lastError, attempt: attempts });
              if (prepared) { attemptMessages = prepared.messages; attemptContext = prepared.context; savedText = attemptContext?.resumeText ?? savedText; }
            }
            previous = { id: current.id, runtime: provider.runtime, protocol: provider.protocol, modelId: model.modelId };
            appender = continuationAppender(savedText);
            for await (const event of stream({ provider, model, messages: attemptMessages, maxOutputTokens: current.max_output_tokens ? Math.min(maxOutputTokens, current.max_output_tokens) : maxOutputTokens, systemPrompt, signal: attemptSignal, mode, effort, skillIds, webSearch, context: attemptContext })) {
              attemptSignal.throwIfAborted();
              if (event.type === 'delta' && typeof event.text === 'string' && event.text.length) {
                const output = append(appender.push(event.text));
                if (output) yield output;
              } else if (event.type === 'reasoning' && typeof event.text === 'string' && event.text.length) {
                yield event;
              } else if (event.type === 'usage') pendingUsage = event;
              else if (event.type === 'activity' || event.type === 'artifact') {
                if (event.committed || event.type === 'artifact') committedTools = true;
                yield event;
              }
            }
            attemptSignal.throwIfAborted();
            const output = append(appender.finish()); if (output) yield output;
            if (!attemptText) throw new UpstreamError('模型没有返回可显示的文本。', 'EMPTY_UPSTREAM_OUTPUT');
            await completeAttempt?.();
            recordSuccess(current);
            auditEnd(auditId, 'complete'); auditFinished = true;
            if (pendingUsage) yield accumulatedUsage(pendingUsage);
            return;
          } catch (error) {
            const output = append(appender?.finish()); if (output) yield output;
            if (!signal?.aborted && attemptSignal.aborted) error = attemptSignal.reason;
            if (!signal?.aborted && ['TimeoutError', 'AbortError'].includes(error?.name)) error = new UpstreamError('上游连接中断或响应超时，已保留进度。', error.name === 'TimeoutError' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_CONNECTION_ERROR', 504);
            const policy = disposition(error, signal);
            auditEnd(auditId, policy.cancelled ? 'stopped' : 'error', policy.cancelled ? null : error);
            auditFinished = true;
            if (pendingUsage) yield accumulatedUsage(pendingUsage);
            if (policy.cancelled) throw signal?.aborted ? signal.reason : error;
            if (policy.channel) {
              const recorded = recordFailure(current, error);
              ownFailureEpoch = recorded?.changes ? store.get('SELECT failure_epoch FROM models WHERE id=?', current.id)?.failure_epoch ?? null : null;
            }
            if (!policy.switch) throw error;
            lastError = error;
            if (!policy.retry || retry >= retryLimit || (!explicitRetries && (halfOpen || inheritedAttempts >= attemptLimit))) break;
            const updated = readCandidate(initial.id, routeKey, variantName, needsVision);
            if (!updated || (cooldown(updated) !== 'closed' && !(explicitRetries && updated.failure_epoch === ownFailureEpoch))) break;
            // Clear the per-attempt deadline before backoff; the next attempt
            // gets a fresh deadline while the caller's cancellation still wins.
            clearTimeout(timer);
            await wait(Math.min(2000, 250 * (2 ** retry)), undefined, { signal });
          } finally {
            clearTimeout(timer);
            // A consumer cancelling iteration closes the attempt without damaging health.
            if (!auditFinished) auditEnd(auditId, 'stopped');
          }
        }
      } finally { if (halfOpen) probes.delete(initial.id); }
    }
    signal?.throwIfAborted();
    if (lastError) throw new UpstreamError(`同一模型的可用通道尝试失败（共 ${attempts} 次）。${sanitizeUpstreamError(lastError)}`, 'ROUTE_EXHAUSTED', 502);
    throw new UpstreamError('该模型的通道正在冷却或恢复检测中，请稍后重试。', 'ROUTE_COOLDOWN', 503);
  }
  return { run };
}
