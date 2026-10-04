import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, Megaphone, X } from 'lucide-react';
import { api, ApiError, errorText, post } from '../api';
import type { Announcement } from '../announcementTypes';
import AnnouncementContent from './AnnouncementContent';
import './announcements.css';

export default function Announcements({ userId }: { userId: string }) {
  const [items, setItems] = useState<Announcement[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0), mounted = useRef(false), saving = useRef(false);
  const account = useRef(userId); account.current = userId;
  const reload = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    mounted.current = true; setItems([]); setError(''); setBusy(false); saving.current = false;
    async function load() {
      if (saving.current) return;
      const token = ++sequence.current;
      try {
        const data = await api<{ announcements: Announcement[] }>('/announcements');
        if (mounted.current && sequence.current === token) { setItems(data.announcements); setError(''); }
      } catch (cause) { if (mounted.current && sequence.current === token) setError(errorText(cause)); }
    }
    reload.current = load; void load();
    const refresh = () => { if (document.visibilityState === 'visible') void load(); };
    window.addEventListener('focus', refresh); window.addEventListener('announcements-updated', refresh);
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => { mounted.current = false; sequence.current++; window.clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('announcements-updated', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [userId]);
  async function dismiss(item: Announcement) {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(''); sequence.current++;
    let refresh = false;
    try {
      await post(`/announcements/${encodeURIComponent(item.id)}/read`, { revision: item.revision });
      refresh = true;
      if (mounted.current && account.current === userId) { sequence.current++; setItems(current => current.filter(value => value.id !== item.id || value.revision !== item.revision)); }
    } catch (cause) {
      refresh = cause instanceof ApiError && [404, 409].includes(cause.status);
      if (mounted.current && account.current === userId) setError(errorText(cause));
    } finally {
      if (mounted.current && account.current === userId) { saving.current = false; setBusy(false); if (refresh) void reload.current(); }
    }
  }
  const item = items[0];
  if (!item && !error) return null;
  return <aside className="workspace-announcements" aria-label="站内公告">
    {error && <div className="announcement-error" role="alert"><span>{error}</span><button type="button" className="button small" disabled={busy} onClick={() => void reload.current()}>刷新公告</button></div>}
    {item && <article key={`${item.id}:${item.revision}`}><div className="announcement-heading"><Megaphone size={17}/><strong>{item.title}</strong>{items.length > 1 && <span>还有 {items.length - 1} 条</span>}<button type="button" className="icon-button" disabled={busy} aria-label="关闭并标记公告已读" onClick={() => void dismiss(item)}><X size={16}/></button></div><div className="announcement-content"><AnnouncementContent>{item.body}</AnnouncementContent></div><div className="announcement-footer"><time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleDateString('zh-CN')}</time><button type="button" className="button small" disabled={busy} onClick={() => void dismiss(item)}>{busy ? <LoaderCircle size={14} className="spin"/> : <Check size={14}/>}知道了</button></div></article>}
  </aside>;
}
