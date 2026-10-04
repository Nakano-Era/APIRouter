import { useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import { errorText } from '../../api';
import type { User } from '../../types';

export default function ChatExportPanel({ users }: { users: User[] }) {
  const [format, setFormat] = useState<'json' | 'markdown'>('markdown');
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const selectedUser = users.find(user => user.id === userId);
  const unavailable = !!userId && !selectedUser;
  async function download() {
    if (busy || unavailable) return; setBusy(true); setError('');
    try {
      const query = new URLSearchParams({ format });
      if (userId) query.set('userId', userId);
      const response = await fetch(`/api/admin/chats/export?${query}`, { credentials: 'same-origin' });
      if (!response.ok) {
        if (response.status === 401) window.dispatchEvent(new Event('session-expired'));
        const data = await response.json().catch(() => ({})); throw new Error(data.error || `导出失败（${response.status}），请稍后重试。`);
      }
      if (!(response.headers.get('Content-Type') || '').toLowerCase().includes('application/zip')) throw new Error('服务器未返回聊天压缩包，请刷新页面后重试。');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      const filename = /filename="([^"]+)"/i.exec(response.headers.get('Content-Disposition') || '')?.[1];
      link.href = url; link.download = filename || `APIRouter-chats-${userId ? `user-${encodeURIComponent(userId)}` : 'all'}-${format}-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  return <section className="settings-card chat-export-panel"><h4>导出聊天记录</h4><p>选择所有用户或指定用户，将聊天记录（含归档）下载为 ZIP。Markdown 方便阅读，JSON 保留结构化数据。</p><label>导出用户<select aria-label="聊天导出用户" value={userId} disabled={busy} onChange={event => { setUserId(event.target.value); setError(''); }}><option value="">所有用户</option>{unavailable && <option value={userId} disabled>所选用户已不存在，请重新选择</option>}{users.map(user => <option key={user.id} value={user.id}>{user.name} · {user.email}{user.disabled ? '（已停用）' : ''}</option>)}</select></label><div className="form-actions"><select aria-label="聊天导出格式" value={format} disabled={busy} onChange={event => setFormat(event.target.value as typeof format)}><option value="markdown">Markdown</option><option value="json">JSON</option></select><button className="button" disabled={busy || unavailable} onClick={() => void download()}>{busy ? <LoaderCircle size={15} className="spin"/> : <Download size={15}/>} {busy ? '正在导出…' : userId ? '导出所选用户聊天' : '导出所有聊天'}</button></div>{error && <div className="alert error" role="alert">{error}</div>}</section>;
}
