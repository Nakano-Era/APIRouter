import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { streamReply, UpstreamError, sanitizeUpstreamError } from './upstream.mjs';

const selection = `SELECT m.*,p.name AS provider_name,p.base_url,p.protocol,p.encrypted_key,
  p.priority,p.failure_threshold,p.cooldown_seconds,p.auth_mode,p.enabled AS provider_enabled
  FROM models m JOIN providers p ON p.id=m.provider_id`;
const nonChannelErrors = new Set([
  'INVALID_BASE_URL', 'BLOCKED_UPSTREAM_ADDRESS', 'INVALID_PROTOCOL', 'INVALID_AUTH_MODE',
  'MISSING_API_KEY', 'INVALID_MESSAGES', 'INVALID_ATTACHMENT', 'VISION_UNSUPPORTED',
  'INVALID_MODEL', 'UNSUPPORTED_TOOL_CALL', 'UNSUPPORTED_OUTPUT', 'OUTPUT_LIMIT_REACHED',
  'UPSTREAM_CONTENT_FILTER', 'UPSTREAM_RESPONSE_TOO_LARGE',
]);
const transientErrors = new Set(['UPSTREAM_CONNECTION_ERROR', 'UPSTREAM_TIMEOUT', 'UPSTREAM_TRUNCATED_STREAM']);
const upstreamFailures = new Set([
  ...transientErrors, 'UPSTREAM_HTTP_ERROR', 'UPSTREAM_REDIRECT', 'INVALID_UPSTREAM_RESPONSE',
  'UPSTREAM_RESPONSE_ERROR', 'UPSTREAM_STREAM_ERROR', 'UPSTREAM_INCOMPLETE', 'EMPTY_UPSTREAM_OUTPUT',
]);
const boundedInteger = (value, min, max, fallback) => Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;

function disposition(error, signal) {
  if (signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') return { cancelled: true, channel: false, retry: false, switch: false };
  if (!(error instanceof UpstreamError) || nonChannelErrors.has(error.code)) return { channel: false, retry: false, switch: false };
  const status = error.upstreamStatus;
  // Invalid payloads should be corrected once, rather than sent to more paid APIs.
  if ([400, 413, 422].includes(status)) return { channel: false, retry: false, switch: false };
  if (!upstreamFailures.has(error.code)) return { channel: false, retry: false, switch: false };
  const retry = transientErrors.has(error.code) || (status >= 500 && status <= 599);
  return { channel: true, retry, switch: true };
}

/** Route one logical reply only among administrator-defined equivalent model aliases. */
export function createRouter({ store, stream = streamReply, clock = Date.now }) {
  const probes = new Set();
  const timestamp = () => new Date(clock()).toISOString();
  function readCandidate(modelId, routeKey, needsVision) {
    return store.get(`${selection} WHERE m.id=? AND m.route_key=? AND m.enabled=1 AND m.available=1 AND p.enabled=1${needsVision ? ' AND m.vision=1' : ''}`, modelId, routeKey);
  }
  function cooldown(candidate) {
    if (!candidate.cooldown_until) return 'closed';
    const until = Date.parse(candidate.cooldown_until);
    // Corrupt persisted state is held closed to traffic until an admin resets it.
    if (!Number.isFinite(until) || until > clock()) return 'open';
    return 'half-open';
  }
  function recordFailure(candidate, error) {
    // A recovery probe must reopen the circuit even if the admin raised its
    // threshold during the preceding cooldown.
    const threshold = candidate.cooldown_until ? 1 : boundedInteger(candidate.failure_threshold, 1, 100, 3);
    const seconds = boundedInteger(candidate.cooldown_seconds, 1, 86_400, 60);
    store.run(`UPDATE models SET failure_count=failure_count+1,status='error',error=?,last_checked_at=?,
      cooldown_until=CASE WHEN failure_count+1>=? THEN ? ELSE cooldown_until END,
      failure_epoch=failure_epoch+CASE WHEN failure_count+1>=? THEN 1 ELSE 0 END
      WHERE id=? AND failure_epoch=?`, sanitizeUpstreamError(error), timestamp(), threshold,
    new Date(clock() + seconds * 1000).toISOString(), threshold, candidate.id, candidate.failure_epoch);
  }
  function recordSuccess(candidate) {
    store.run(`UPDATE models SET failure_count=0,cooldown_until=NULL,status='ok',error=NULL,
      last_checked_at=?,failure_epoch=failure_epoch+1 WHERE id=? AND failure_epoch=?`, timestamp(), candidate.id, candidate.failure_epoch);
  }
  function auditStart(requestId, candidate) {
    if (!requestId) return null;
    const auditId = randomUUID();
    store.run('INSERT INTO route_attempts(id,request_id,provider_id,model_id,outcome,error,created_at) VALUES (?,?,?,?,?,?,?)',
      auditId, requestId, candidate.provider_id, candidate.id, 'running', null, timestamp());
    return auditId;
  }
  function auditEnd(auditId, outcome, error) {
    if (auditId) store.run('UPDATE route_attempts SET outcome=?,error=? WHERE id=?', outcome, error ? sanitizeUpstreamError(error) : null, auditId);
  }

  async function* run({ routeKey, messages, maxOutputTokens, systemPrompt, signal, maxAttempts = 6, retriesPerChannel = 1, onAttempt, requestId }) {
    signal?.throwIfAborted();
    if (typeof routeKey !== 'string' || !routeKey.trim()) throw new UpstreamError('请选择有效的模型路由。', 'INVALID_ROUTE', 400);
    if (!Array.isArray(messages) || !messages.length) throw new UpstreamError('消息不能为空。', 'INVALID_MESSAGES', 400);
    const needsVision = messages.some(message => message.attachments?.some(attachment => attachment.kind === 'image'));
    const candidates = store.all(`${selection} WHERE m.route_key=? AND m.enabled=1 AND m.available=1 AND p.enabled=1${needsVision ? ' AND m.vision=1' : ''} ORDER BY p.priority DESC,m.id ASC`, routeKey);
    if (!candidates.length) throw new UpstreamError(needsVision ? '该模型路由没有支持图片的可用通道。' : '该模型路由没有可用通道，请联系管理员。', needsVision ? 'VISION_UNSUPPORTED' : 'ROUTE_UNAVAILABLE', 400);
    const attemptLimit = boundedInteger(maxAttempts, 1, 10, 6);
    const retryLimit = boundedInteger(retriesPerChannel, 0, 3, 1);
    let attempts = 0;
    let lastError;
    let emittedText = false;
    for (const initial of candidates) {
      signal?.throwIfAborted();
      if (attempts >= attemptLimit) break;
      let current = readCandidate(initial.id, routeKey, needsVision);
      if (!current || cooldown(current) === 'open' || probes.has(current.id)) continue;
      const halfOpen = cooldown(current) === 'half-open';
      if (halfOpen) probes.add(current.id);
      try {
        for (let retry = 0; retry <= (halfOpen ? 0 : retryLimit); retry++) {
          signal?.throwIfAborted();
          if (attempts >= attemptLimit) break;
          current = readCandidate(initial.id, routeKey, needsVision);
          if (!current || cooldown(current) === 'open' || (!halfOpen && probes.has(current.id))) break;
          // Decryption and local configuration errors are not channel outages.
          const provider = {
            id: current.provider_id, name: current.provider_name, baseUrl: current.base_url,
            protocol: current.protocol, authMode: current.auth_mode ?? 'auto',
            apiKey: store.decrypt(current.encrypted_key),
          };
          const model = { id: current.id, modelId: current.model_id, vision: !!current.vision };
          const selected = { type: 'selected', modelId: current.id, providerId: current.provider_id,
            providerName: current.provider_name, upstreamModelId: current.model_id };
          if (attempts > 0) yield { type: 'routing', message: retry > 0 ? '通道暂时无响应，正在重试。' : '当前通道不可用，正在切换同一模型的其他通道。' };
          await onAttempt?.({ ...selected, attempt: attempts + 1 });
          signal?.throwIfAborted();
          yield selected;
          signal?.throwIfAborted();
          attempts++;
          const auditId = auditStart(requestId, current);
          let auditFinished = false;
          let attemptText = false;
          let pendingUsage;
          try {
            for await (const event of stream({ provider, model, messages, maxOutputTokens, systemPrompt, signal })) {
              signal?.throwIfAborted();
              if (event.type === 'delta' && typeof event.text === 'string' && event.text.length) {
                attemptText = true; emittedText = true;
                yield event;
              } else if (event.type === 'usage') pendingUsage = event;
            }
            signal?.throwIfAborted();
            if (!attemptText) throw new UpstreamError('模型没有返回可显示的文本。', 'EMPTY_UPSTREAM_OUTPUT');
            recordSuccess(current);
            auditEnd(auditId, 'complete'); auditFinished = true;
            if (pendingUsage) yield pendingUsage;
            return;
          } catch (error) {
            const policy = disposition(error, signal);
            auditEnd(auditId, policy.cancelled ? 'stopped' : 'error', policy.cancelled ? null : error);
            auditFinished = true;
            if (policy.cancelled) throw signal?.aborted ? signal.reason : error;
            if (policy.channel) recordFailure(current, error);
            if (emittedText || !policy.switch) throw error;
            lastError = error;
            if (!policy.retry || retry >= retryLimit || halfOpen || attempts >= attemptLimit) break;
            const updated = readCandidate(initial.id, routeKey, needsVision);
            if (!updated || cooldown(updated) !== 'closed') break;
            await sleep(250 * (2 ** retry), undefined, { signal });
          } finally {
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
