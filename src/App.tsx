import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, Check, LoaderCircle, PanelLeft, Sparkles, SquarePen, X } from 'lucide-react';
import { api, errorText, post, setSessionToken } from './api';
import type { Session, User } from './types';
import { useChat } from './hooks/useChat';
import Auth from './components/Auth';
import Brand from './components/Brand';
import Sidebar from './components/Sidebar';
import Composer from './components/Composer';
import ModelPicker from './components/ModelPicker';
const MessageList = lazy(() => import('./components/MessageList'));
const SettingsModal = lazy(() => import('./components/SettingsModal'));
const BillingModal = lazy(() => import('./components/BillingModal'));

function Workspace({ user, onLogout, theme, onTheme }: { user: User; onLogout: () => void; theme: string; onTheme: (theme: string) => void }) {
  const chat = useChat();
  const [mobileOpen, setMobileOpen] = useState(false); const [sidebarCollapsed, setSidebarCollapsed] = useState(false); const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState(''); const [draftKey, setDraftKey] = useState(0); const [composerVersion, setComposerVersion] = useState(0);
  const [exported, setExported] = useState(false);
  const [billingOpen, setBillingOpen] = useState(() => new URLSearchParams(window.location.search).has('billing'));
  const [membership, setMembership] = useState<{planName:string;activeUntil:string;source:string} | null>(null);
  const refreshBilling = useCallback(async () => { const result = await api<{membership:{planName:string;activeUntil:string;source:string}|null}>('/billing'); setMembership(result.membership); }, []);
  const refreshWorkspace = useCallback(async () => { await Promise.all([chat.refreshModels(), refreshBilling()]); }, [chat.refreshModels, refreshBilling]);
  useEffect(() => { void refreshBilling().catch(() => {}); const refresh = () => { void refreshBilling().catch(() => {}); }; window.addEventListener('focus', refresh); const timer = window.setInterval(refresh,60000); return () => { window.removeEventListener('focus',refresh); window.clearInterval(timer); }; }, [refreshBilling]);
  const closeSidebar = useCallback(() => setMobileOpen(false), []);
  const showSidebar = useCallback(() => { setSidebarCollapsed(false); setMobileOpen(window.matchMedia('(max-width: 800px)').matches); }, []);
  const selected = chat.models.find(model => model.id === chat.modelId);
  const currentChat = chat.chats.find(item => item.id === chat.selectedId);
  const empty = !chat.messages.length && !chat.generating && !chat.chatLoading;
  function resetComposer() { setDraft(''); setDraftKey(key => key + 1); setComposerVersion(key => key + 1); }
  function newChat() { if (chat.generating) return; chat.newChat(); resetComposer(); }
  async function openChat(id: string) { const previousId = chat.selectedId; if (id === previousId && !chat.chatLoading) return; const opened = await chat.openChat(id); if (opened && id !== previousId) resetComposer(); }
  function exportChat() {
    if (!currentChat) return;
    const content = `# ${currentChat.title}\n\n` + chat.messages.map(message => `## ${message.role === 'user' ? '你' : '助手'}\n\n${message.content}${message.attachments.length ? '\n\n附件：' + message.attachments.map(file => file.name).join('、') : ''}`).join('\n\n---\n\n');
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' }); const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `${currentChat.title.replace(/[<>:"/\\|?*]/g, '_').slice(0,80) || '对话'}.md`; link.click(); URL.revokeObjectURL(url);
    setExported(true); window.setTimeout(() => setExported(false), 2000);
  }
  async function logout() { try { await post('/auth/logout'); onLogout(); } catch (err) { chat.setError(errorText(err)); } }
  return <div className={`workspace ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    <Sidebar chats={chat.chats} selectedId={chat.selectedId} user={user} siteName={chat.settings?.siteName || 'APIRouter'} mobileOpen={mobileOpen} onClose={closeSidebar} onShow={showSidebar} onCollapse={() => { setSidebarCollapsed(true); setMobileOpen(false); }} onNew={newChat}
      onOpen={id => void openChat(id)} onUpdate={(id,values) => void chat.updateChat(id,values)} onDelete={id => void chat.deleteChat(id)}
      onSettings={() => setSettingsOpen(true)} onUpgrade={() => setBillingOpen(true)} planName={membership?.planName || '免费'} onLogout={() => void logout()} disabled={chat.generating}/>
    <main className={`main-panel ${empty ? 'is-empty' : ''}`}>
      <header className="topbar"><div className="topbar-left">
        <button className="icon-button sidebar-open-button" onClick={showSidebar} aria-label="打开侧栏" title="打开侧栏"><PanelLeft size={21}/></button>
        <button className="icon-button collapsed-new-chat" onClick={newChat} disabled={chat.generating} aria-label="新聊天" title="新聊天"><SquarePen size={21}/></button>
        <ModelPicker models={chat.models} value={chat.modelId} onChange={chat.setModelId} disabled={chat.generating} isAdmin={user.role === 'admin'} onSettings={() => setSettingsOpen(true)}/>
      </div><div className="topbar-right">
        <button className="upgrade-button" onClick={() => setBillingOpen(true)}><Sparkles size={15}/><span>{membership ? '管理套餐' : '升级套餐'}</span></button>
        {currentChat && <button className="icon-button export-button" onClick={exportChat} aria-label="导出对话" title="导出 Markdown">{exported ? <Check size={18}/> : <ArrowDownToLine size={18}/>}</button>}
        <button className="icon-button mobile-only" onClick={newChat} disabled={chat.generating} aria-label="新聊天"><SquarePen size={21}/></button>
      </div></header>
      {chat.loading ? <div className="app-loading"><LoaderCircle size={26} className="spin"/><p>正在打开工作空间…</p></div> : <>
        <div className={`chat-layout ${empty ? 'empty-layout' : ''}`}>
          {empty && <div className="welcome-content"><div className="welcome-intro">
            <h1>有什么可以帮忙的？</h1>
          </div></div>}
          {!empty && <Suspense fallback={<div className="app-loading"><LoaderCircle size={23} className="spin"/></div>}><MessageList messages={chat.messages} models={chat.models} generating={chat.generating} onRegenerate={() => void chat.generate('',[],'regenerate')}
            onEdit={(message,content) => chat.generate(content,message.attachments,'edit',message.id)} loading={chat.chatLoading}/></Suspense>}
          <div className="composer-zone">{chat.routingNotice && <div className="routing-progress" role="status"><LoaderCircle size={14} className="spin"/>{chat.routingNotice}</div>}<Composer key={composerVersion} onSend={(content,files) => chat.generate(content,files)} onStop={() => void chat.stop()}
            generating={chat.generating} model={chat.chatLoading ? undefined : selected} draft={draft} draftKey={draftKey} onError={chat.setError}/></div>
          {empty && chat.models.length === 0 && <div className="configuration-hint">{user.role === 'admin' ? <><span>连接 API 后即可开始聊天。</span><button onClick={() => setSettingsOpen(true)}>配置 API</button></> : <span>暂时没有可用模型，请联系管理员。</span>}</div>}
        </div>
        {chat.error && <div className="workspace-alert" role="alert"><span>{chat.error}</span><button className="icon-button" aria-label="关闭提示" onClick={() => chat.setError('')}><X size={15}/></button></div>}
        <footer className="workspace-footer">AI 也可能会犯错，请核查重要信息。</footer>
      </>}
    </main>
    {settingsOpen && <Suspense fallback={<div className="modal-overlay"><LoaderCircle className="spin" size={26}/></div>}><SettingsModal user={user} theme={theme} onTheme={onTheme} onClose={() => setSettingsOpen(false)} onUpdated={refreshWorkspace}/></Suspense>}
    {billingOpen && <Suspense fallback={<div className="modal-overlay"><LoaderCircle className="spin" size={26}/></div>}><BillingModal onClose={() => setBillingOpen(false)} onChanged={refreshWorkspace}/></Suspense>}
  </div>;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null); const [error, setError] = useState('');
  const [theme, setTheme] = useState(() => localStorage.getItem('apirouter-theme') || 'dark');
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('apirouter-theme', theme); }, [theme]);
  const load = useCallback(() => { setError(''); api<Session>('/auth/session').then(result => { setSessionToken(result); setSession(result); }).catch(err => setError(errorText(err))); }, []);
  useEffect(() => {
    load(); const expired = () => { setSessionToken({user:null,needsSetup:false}); setSession({user:null,needsSetup:false}); };
    window.addEventListener('session-expired',expired); return () => window.removeEventListener('session-expired',expired);
  }, [load]);
  if (!session) return <div className="boot-screen"><Brand/>{error ? <><p className="muted">{error}</p><button className="button" onClick={load}>重新连接</button></> : <LoaderCircle size={23} className="spin"/>}</div>;
  if (!session.user) return <Auth session={session} onSession={setSession}/>;
  return <Workspace user={session.user} theme={theme} onTheme={setTheme} onLogout={() => { setSessionToken({user:null,needsSetup:false}); setSession({user:null,needsSetup:false}); }}/>;
}
