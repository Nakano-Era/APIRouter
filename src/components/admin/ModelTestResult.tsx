import { useEffect, useRef, useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import './model-test-result.css';
import type { RawDiagnostic } from '../../types';
import RawDiagnosticDetails, { rawDiagnosticText } from './RawDiagnosticDetails';

export interface ModelTestResponse {
  ok: boolean;
  error?: string;
  latencyMs: number;
  diagnostic?: {
    version: 2;
    protocol: string;
    authMode: string;
    method: string;
    path: string;
    modelId: string;
    upstreamStatus?: number;
    responseFormat: string;
    detail?: string;
    note: string;
    requestId?: string;
    raw?: RawDiagnostic;
  };
}

export interface ModelTestReport {
  result: ModelTestResponse;
  providerName: string;
  modelId: string;
  testedAt: string;
}

function diagnosticText(report: ModelTestReport) {
  const { result, providerName, modelId, testedAt } = report;
  const diagnostic = result.diagnostic;
  const lines = [
    `APIRouter 模型测试${diagnostic ? ` · 诊断 v${diagnostic.version}` : ''}`,
    `结果：${result.ok ? '成功' : '失败'}`,
    `测试时间：${testedAt}`,
    `API 连接：${providerName}`,
    `上游模型 ID：${diagnostic?.modelId || modelId}`,
    `耗时：${Math.round(result.latencyMs)} ms`,
  ];
  if (diagnostic) {
    lines.push(
      `接口协议：${diagnostic.protocol}`,
      `认证方式：${diagnostic.authMode}`,
      `请求路径：${diagnostic.method} ${diagnostic.path}`,
      `上游 HTTP 状态：${diagnostic.upstreamStatus ?? '未提供'}`,
      `响应格式：${diagnostic.responseFormat || '未提供'}`,
    );
    if (diagnostic.requestId) lines.push(`上游请求 ID：${diagnostic.requestId}`);
    if (diagnostic.detail) lines.push(`上游说明（已脱敏）：${diagnostic.detail}`);
    if (diagnostic.note) lines.push(`诊断说明：${diagnostic.note}`);
  } else {
    lines.push('诊断说明：本次响应未提供结构化诊断。请确认已更新前后端；若请求未到达服务器，请检查连接后重试。');
  }
  if (result.error) lines.push(`错误：${result.error}`);
  if (diagnostic?.raw) lines.push(`原始响应（已脱敏）：\n${rawDiagnosticText(diagnostic.raw)}`);
  return lines.join('\n');
}

export default function ModelTestResult({ report, onClose }: { report: ModelTestReport; onClose: () => void }) {
  const card = useRef<HTMLElement>(null);
  const fallback = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const text = diagnosticText(report);

  useEffect(() => {
    setCopied(false);
    setCopyFailed(false);
    card.current?.scrollIntoView({ block: 'nearest' });
  }, [report]);
  useEffect(() => {
    if (copyFailed) { fallback.current?.focus(); fallback.current?.select(); }
  }, [copyFailed]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopied(false);
      setCopyFailed(true);
      fallback.current?.focus();
      fallback.current?.select();
    }
  }

  return <section ref={card} className="settings-card model-test-result" aria-label="本次模型测试结果">
    <div className="card-heading">
      <strong>本次模型测试结果</strong>
      <button className="icon-button" onClick={onClose} aria-label="关闭本次测试结果"><X size={16}/></button>
    </div>
    <div className="model-test-summary" role="status">
      <span className={`model-status ${report.result.ok ? 'ok' : 'error'}`}>{report.result.ok ? '测试成功' : '测试失败'}</span>
      <span>{Math.round(report.result.latencyMs)} ms</span>
      <span>{report.providerName} · {report.modelId}</span>
    </div>
    <p className="muted small-text">此卡片保留本次测试的诊断，可直接复制用于排查。</p>
    <pre className="model-test-diagnostic">{text.replace(/原始响应（已脱敏）：[\s\S]*$/, "")}</pre>
    {report.result.diagnostic?.raw && <RawDiagnosticDetails detail={report.result.diagnostic.raw}/> }
    <div className="form-actions"><button className="button small" onClick={() => void copy()}>{copied ? <Check size={15}/> : <Copy size={15}/>} {copied ? '已复制诊断' : '复制诊断'}</button></div>
    {copyFailed && <div className="model-test-copy-fallback">
      <p className="muted small-text" role="alert">浏览器未允许自动复制，请复制下方已选中的诊断文本。</p>
      <textarea ref={fallback} aria-label="手动复制模型测试诊断" readOnly rows={10} value={text} onFocus={event => event.currentTarget.select()}/>
    </div>}
  </section>;
}
