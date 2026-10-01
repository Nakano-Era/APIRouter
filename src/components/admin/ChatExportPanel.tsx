import { useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import { errorText } from '../../api';

export default function ChatExportPanel() {
  const [format, setFormat] = useState<'json' | 'markdown'>('markdown');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function download() {
    if (busy) return; setBusy(true); setError('');
    try {
      const response = await fetch(`/api/admin/chats/export?format=${format}`, { credentials: 'same-origin' });
      if (!response.ok) {
        if (response.status === 401) window.dispatchEvent(new Event('session-expired'));
        const data = await response.json().catch(() => ({})); throw new Error(data.error || `导出失败（${response.status}），请稍后重试。`);
      }
      if (!(response.headers.get('Content-Type') || '').toLowerCase().includes('application/zip')) throw new Error('服务器未返回聊天压缩包，请刷新页面后重试。');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = `apirouter-all-chats-${format}-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  return <section className="settings-card chat-export-panel"><h4>导出所有用户聊天</h4><p>将全体用户的聊天记录下载为 ZIP。选择 Markdown 方便阅读，选择 JSON 保留结构化数据。</p><div className="form-actions"><select aria-label="聊天导出格式" value={format} disabled={busy} onChange={event => setFormat(event.target.value as typeof format)}><option value="markdown">Markdown</option><option value="json">JSON</option></select><button className="button" disabled={busy} onClick={() => void download()}>{busy ? <LoaderCircle size={15} className="spin"/> : <Download size={15}/>}导出所有聊天</button></div>{error && <div className="alert error" role="alert">{error}</div>}</section>;
}
