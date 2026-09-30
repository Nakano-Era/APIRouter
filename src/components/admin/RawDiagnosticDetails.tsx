import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { RawDiagnostic } from '../../types';
export function rawDiagnosticText(detail: RawDiagnostic) {
  const { body, ...metadata } = detail;
  return `${JSON.stringify(metadata, null, 2)}\n\n----- 原始响应体 -----\n${typeof body === 'string' ? body : JSON.stringify(body ?? null, null, 2)}`;
}
export default function RawDiagnosticDetails({ detail }: { detail: RawDiagnostic }) {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  const text = rawDiagnosticText(detail);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setManual(false); }
    catch { setManual(true); }
  }
  return <details className="raw-diagnostic"><summary>查看原始错误响应（已脱敏）</summary>
    <p className="raw-diagnostic-note">保留上游返回的响应头和原始正文，凭证已遮盖。{detail.truncated ? '响应达到保存上限或读取提前结束，以下为已保存的内容。' : ''}{detail.readNote ? ` ${detail.readNote}` : ''}</p>
    <pre>{text}</pre>
    <div className="form-actions"><button className="button small" onClick={() => void copy()}>{copied ? <Check size={14}/> : <Copy size={14}/>} {copied ? '已复制原始响应' : '复制原始响应'}</button></div>
    {manual && <label className="raw-diagnostic-note">浏览器未允许自动复制，请选择下方文本手动复制。<textarea autoFocus readOnly rows={8} value={text} onFocus={event => event.currentTarget.select()}/></label>}
  </details>;
}
