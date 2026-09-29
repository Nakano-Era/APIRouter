import { useEffect, useRef, useState } from 'react';
import { Archive, ArchiveRestore, Check, ChevronUp, LogOut, MoreHorizontal, PanelLeftClose, Pencil, Pin, Search, Settings, Shield, Sparkles, SquarePen, Trash2, X } from 'lucide-react';
import type { Chat, User } from '../types';
import Brand from './Brand';
import Modal from './Modal';

interface SidebarProps {
  chats: Chat[]; selectedId: string | null; user: User; siteName: string; mobileOpen: boolean;
  onClose: () => void; onShow: () => void; onCollapse: () => void; onNew: () => void; onOpen: (id: string) => void;
  onUpdate: (id: string, values: Partial<Chat>) => void; onDelete: (id: string) => void;
  onSettings: () => void; onUpgrade: () => void; planName: string; onLogout: () => void; disabled: boolean;
}

export default function Sidebar({ chats, selectedId, user, siteName, mobileOpen, onClose, onShow, onCollapse, onNew, onOpen, onUpdate, onDelete, onSettings, onUpgrade, planName, onLogout, disabled }: SidebarProps) {
  const [query, setQuery] = useState(''); const [archiveView, setArchiveView] = useState(false);
  const [menu, setMenu] = useState<string | null>(null); const [accountOpen, setAccountOpen] = useState(false);
  const [editing, setEditing] = useState<Chat | null>(null); const [title, setTitle] = useState(''); const [deleting, setDeleting] = useState<Chat | null>(null);
  const searchRef = useRef<HTMLInputElement>(null); const sidebarRef = useRef<HTMLElement>(null); const accountRef = useRef<HTMLDivElement>(null);
  const focusSearchOnShow = useRef(false);

  useEffect(() => {
    function key(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); focusSearchOnShow.current = true; onShow(); window.requestAnimationFrame(() => searchRef.current?.focus());
      }
      if (event.key === 'Escape') { setMenu(null); setAccountOpen(false); onClose(); }
      if (event.key === 'Tab' && mobileOpen && window.matchMedia('(max-width: 800px)').matches) {
        const focusable = Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') || []).filter(element => element.getClientRects().length > 0);
        const first = focusable[0]; const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, [onClose, onShow, mobileOpen]);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false); };
    document.addEventListener('mousedown',close); return () => document.removeEventListener('mousedown',close);
  }, []);
  useEffect(() => {
    if (!mobileOpen || !window.matchMedia('(max-width: 800px)').matches) return;
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => { if (focusSearchOnShow.current) searchRef.current?.focus(); else sidebarRef.current?.querySelector<HTMLButtonElement>('.mobile-sidebar-close')?.focus(); focusSearchOnShow.current = false; });
    return () => { cancelAnimationFrame(frame); previous?.focus(); };
  }, [mobileOpen]);

  const filtered = chats.filter(chat => chat.archived === archiveView && chat.title.toLowerCase().includes(query.toLowerCase())).sort((a,b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const pinned = filtered.filter(chat => chat.pinned); const recent = filtered.filter(chat => !chat.pinned);
  function row(chat: Chat) {
    return <div className={`chat-row ${selectedId === chat.id ? 'active' : ''}`} key={chat.id}>
      <button className="chat-select" onClick={() => { onOpen(chat.id); onClose(); }} disabled={disabled}><span>{chat.title || '新聊天'}</span></button>
      <button className={`chat-more icon-button ${menu === chat.id ? 'visible' : ''}`} title="聊天选项" aria-label={`${chat.title} 的选项`} onClick={() => setMenu(menu === chat.id ? null : chat.id)} disabled={disabled}><MoreHorizontal size={18}/></button>
      {menu === chat.id && <><button className="popover-dismiss" aria-label="关闭菜单" onClick={() => setMenu(null)}/><div className="chat-menu popover">
        <button onClick={() => { setEditing(chat); setTitle(chat.title); setMenu(null); }}><Pencil size={16}/>重命名</button>
        <button onClick={() => { onUpdate(chat.id,{pinned:!chat.pinned}); setMenu(null); }}><Pin size={16}/>{chat.pinned ? '取消置顶' : '置顶聊天'}</button>
        <button onClick={() => { onUpdate(chat.id,{archived:!chat.archived}); setMenu(null); }}><Archive size={16}/>{chat.archived ? '移出归档' : '归档聊天'}</button>
        <button className="danger-text" onClick={() => { setDeleting(chat); setMenu(null); }}><Trash2 size={16}/>删除聊天</button>
      </div></>}
    </div>;
  }
  function settings() { setAccountOpen(false); onClose(); onSettings(); }
  return <>
    <div className={`sidebar-shade ${mobileOpen ? 'show' : ''}`} onClick={onClose}/>
    <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`} ref={sidebarRef} aria-label="聊天侧栏">
      <div className="sidebar-brand"><Brand/>
        <button className="icon-button desktop-sidebar-close" onClick={onCollapse} aria-label="收起侧栏" title="收起侧栏"><PanelLeftClose size={20}/></button>
        <button className="icon-button mobile-only mobile-sidebar-close" onClick={onClose} aria-label="关闭侧栏"><PanelLeftClose size={20}/></button>
      </div>
      <button className="new-chat-button" onClick={() => { onNew(); onClose(); }} disabled={disabled}><SquarePen size={20}/><span>新聊天</span></button>
      <div className="sidebar-search"><Search size={20}/><input ref={searchRef} aria-label="搜索聊天" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索聊天"/>
        {query && <button className="icon-button" aria-label="清除搜索" onClick={() => setQuery('')}><X size={15}/></button>}
      </div>
      <div className="sidebar-history">
        {archiveView && <button className="archive-heading" onClick={() => setArchiveView(false)}><ArchiveRestore size={15}/>已归档的聊天<span>返回</span></button>}
        {pinned.length > 0 && <><div className="history-heading">已置顶</div>{pinned.map(row)}</>}
        {recent.length > 0 && <><div className="history-heading">{query ? '搜索结果' : archiveView ? '已归档' : '你的聊天'}</div>{recent.map(row)}</>}
        {filtered.length === 0 && (query || archiveView) && <div className="history-empty">{query ? '没有找到相关聊天' : '没有已归档的聊天'}</div>}
      </div>
      <div className="sidebar-bottom"><div className="account-area" ref={accountRef}>
        {accountOpen && <div className="account-menu popover"><div className="account-details"><strong>{user.name}</strong><span>{user.email}</span><small>{siteName}{user.role === 'admin' ? ' · 管理员' : ''}</small></div>
          <button onClick={() => { setAccountOpen(false); onClose(); onUpgrade(); }}><Sparkles size={17}/>套餐与订阅</button>
          {user.role === 'admin' && <button onClick={settings}><Shield size={17}/>管理工作空间</button>}
          <button onClick={() => { setArchiveView(!archiveView); setAccountOpen(false); }}><Archive size={17}/>{archiveView ? '返回全部聊天' : '已归档的聊天'}</button>
          {user.role !== 'admin' && <button onClick={settings}><Settings size={17}/>设置</button>}
          <button onClick={onLogout}><LogOut size={17}/>退出登录</button>
        </div>}
        <button className="account-button" onClick={() => setAccountOpen(!accountOpen)} aria-expanded={accountOpen} aria-label="账号与设置">
          <span className="avatar">{user.name.slice(0,1).toUpperCase()}</span><span className="account-name"><strong>{user.name}</strong><small className="account-plan">{planName}</small></span><ChevronUp size={16}/>
        </button>
      </div></div>
    </aside>
    {editing && <Modal title="重命名聊天" onClose={() => setEditing(null)}><form className="modal-body stack" onSubmit={event => { event.preventDefault(); onUpdate(editing.id,{title:title.trim()}); setEditing(null); }}>
      <label>聊天名称<input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} required autoFocus/></label>
      <div className="form-actions"><button type="button" className="button" onClick={() => setEditing(null)}>取消</button><button className="button primary" disabled={!title.trim()}><Check size={15}/>保存</button></div>
    </form></Modal>}
    {deleting && <Modal title="删除聊天？" onClose={() => setDeleting(null)}><div className="modal-body"><p className="muted">「{deleting.title}」和其中的消息将被永久删除。</p>
      <div className="form-actions"><button className="button" onClick={() => setDeleting(null)}>取消</button><button className="button danger" onClick={() => { onDelete(deleting.id); setDeleting(null); }}>删除聊天</button></div>
    </div></Modal>}
  </>;
}
