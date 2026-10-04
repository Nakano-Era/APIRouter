import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Check, Eye, LoaderCircle, Megaphone, Pencil, Plus, RefreshCw } from 'lucide-react';
import { api, ApiError, errorText, patch, post } from '../../api';
import type { Announcement } from '../../announcementTypes';
import AnnouncementContent from '../AnnouncementContent';
import '../announcements.css';

export default function AnnouncementsPanel() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<Announcement | 'new' | null>(null);
  const [title, setTitle] = useState(''), [body, setBody] = useState('');
  const [published, setPublished] = useState(false), [preview, setPreview] = useState(false);
  const [conflict, setConflict] = useState(false);
  const load = useCallback(async () => { const result = await api<{ announcements: Announcement[] }>('/admin/announcements'); setItems(result.announcements); }, []);
  useEffect(() => { void load().catch(cause => setError(errorText(cause))).finally(() => setLoading(false)); }, [load]);
  async function refresh() { setLoading(true); setError(''); try { await load(); } catch (cause) { setError(errorText(cause)); } finally { setLoading(false); } }
  function edit(value: Announcement | 'new') {
    setEditing(value); setTitle(value === 'new' ? '' : value.title); setBody(value === 'new' ? '' : value.body); setPublished(value !== 'new' && value.status === 'published'); setPreview(false); setError(''); setNotice(''); setConflict(false);
  }
  function update(value: Announcement) {
    setItems(current => [value, ...current.filter(item => item.id !== value.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    window.dispatchEvent(new Event('announcements-updated'));
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!editing || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const data = { title, body, status: published ? 'published' : 'draft' };
      const result = editing === 'new' ? await post<{ announcement: Announcement }>('/admin/announcements', data) : await patch<{ announcement: Announcement }>(`/admin/announcements/${encodeURIComponent(editing.id)}`, { ...data, revision: editing.revision });
      update(result.announcement); setEditing(null); setNotice(published ? '公告已发布，用户进入工作空间时即可看到。' : '公告已保存为草稿，用户不可见。');
    } catch (cause) { setError(errorText(cause)); setConflict(cause instanceof ApiError && cause.status === 409); } finally { setBusy(false); }
  }
  async function readLatest() {
    if (!editing || editing === 'new') return;
    setBusy(true); setError('');
    try {
      const result = await api<{ announcements: Announcement[] }>('/admin/announcements');
      setItems(result.announcements);
      const latest = result.announcements.find(item => item.id === editing.id);
      if (latest) edit(latest); else { setEditing(null); setConflict(false); setNotice('此公告已不在列表中。'); }
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  async function toggle(item: Announcement) {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await patch<{ announcement: Announcement }>(`/admin/announcements/${encodeURIComponent(item.id)}`, { revision: item.revision, status: item.status === 'published' ? 'draft' : 'published' });
      update(result.announcement); setNotice(result.announcement.status === 'published' ? '公告已发布。' : '公告已下架并保留为草稿。');
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  return <section className="admin-section announcement-admin"><div className="section-title"><div><h3>站内公告</h3><p>发布更新和通知，用户关闭后在所有设备同步已读。</p></div><button type="button" className="button primary small" disabled={busy || !!editing} onClick={() => edit('new')}><Plus size={15}/>新建公告</button></div>
    {error && <div className="alert error" role="alert">{error}</div>}{notice && <div className="alert success" role="status"><Check size={16}/>{notice}</div>}
    {conflict && editing && <div className="field-help"><p>当前修改尚未保存；读取最新版本会替换编辑区内容。</p><button type="button" className="button small" disabled={busy} onClick={() => void readLatest()}><RefreshCw size={14}/>读取最新版本</button></div>}
    {editing && <form className="settings-card stack announcement-form" onSubmit={save}><label>公告标题<input value={title} required maxLength={120} disabled={busy} onChange={event => setTitle(event.target.value)}/></label><label>公告内容（支持 Markdown 与数学公式）<textarea value={body} required maxLength={20000} rows={9} disabled={busy} onChange={event => setBody(event.target.value)}/></label><p className="field-help">纯文字、列表、链接和公式均可；不运行 HTML。修改已发布公告后，用户需要重新阅读。</p><label className="checkbox-label"><input type="checkbox" checked={published} disabled={busy} onChange={event => setPublished(event.target.checked)}/>保存后立即发布</label><div className="form-actions"><button type="button" className="button small" onClick={() => setPreview(!preview)}><Eye size={14}/>{preview ? '收起预览' : '预览'}</button><button type="button" className="button small" disabled={busy} onClick={() => setEditing(null)}>取消</button><button className="button primary small" disabled={busy || !title.trim() || !body.trim()}>{busy ? <LoaderCircle size={14} className="spin"/> : <Check size={14}/>}保存{published ? '并发布' : '草稿'}</button></div>{preview && <div className="announcement-preview"><strong>{title || '公告标题'}</strong><AnnouncementContent>{body}</AnnouncementContent></div>}</form>}
    <div className="announcement-list-heading"><span>{items.length} 条公告</span><button type="button" className="button small" disabled={busy || loading || !!editing} onClick={() => void refresh()}><RefreshCw size={14}/>刷新</button></div>
    {loading && <p className="field-help"><LoaderCircle size={15} className="spin"/>正在读取公告…</p>}
    {!loading && !items.length && <p className="field-help">暂无公告，点击“新建公告”添加。</p>}
    <div className="announcement-admin-list">{items.map(item => <article className="settings-card announcement-admin-item" key={item.id}><div><strong>{item.title}</strong><span>{item.status === 'published' ? '已发布' : '草稿'} · 第 {item.revision} 版 · {new Date(item.updatedAt).toLocaleString('zh-CN')}</span><p>{item.body.slice(0, 160)}{item.body.length > 160 ? '…' : ''}</p></div><div className="form-actions"><button type="button" className="button small" disabled={busy || !!editing} onClick={() => edit(item)}><Pencil size={14}/>编辑</button><button type="button" className="button small" disabled={busy || !!editing} onClick={() => void toggle(item)}><Megaphone size={14}/>{item.status === 'published' ? '下架' : '发布'}</button></div></article>)}</div>
  </section>;
}
