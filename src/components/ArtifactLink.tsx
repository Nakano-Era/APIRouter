import { useState, type ReactNode } from 'react';
import type { WorkArtifact } from '../types';
import { downloadArtifact, resolveArtifactLink } from '../lib/artifact-downloads';
import './artifact-downloads.css';

export function DownloadLink({ url, name, children, className = '' }: { url: string; name: string; children: ReactNode; className?: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <span className="artifact-download-control"><a href={url} download={name} className={className} aria-busy={busy} onClick={event => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    void downloadArtifact(url, name).catch(cause => setError(cause instanceof Error ? cause.message : '文件下载失败，请重试。')).finally(() => setBusy(false));
  }}>{children}{busy && <span className="artifact-download-progress"> 正在下载…</span>}</a>{error && <span className="artifact-download-error" role="alert">{error}</span>}</span>;
}

export default function ArtifactLink({ href, artifacts, children, generating = false }: { href?: string; artifacts: WorkArtifact[]; children: ReactNode; generating?: boolean }) {
  const target = resolveArtifactLink(href, artifacts);
  if (target.kind === 'external') return <a href={target.url} target="_blank" rel="noopener noreferrer">{children}</a>;
  if (target.kind === 'missing') return <span className="artifact-unavailable" title="仅能下载当前对话中实际生成并保存的任务文件。">{children}<small>{generating ? '（等待文件生成）' : '（文件未生成或未保存，请让 Work 将文件保存到 output/）'}</small></span>;
  return <DownloadLink url={target.url} name={target.name}>{children}</DownloadLink>;
}
