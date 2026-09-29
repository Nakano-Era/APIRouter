import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, LoaderCircle, LockKeyhole, ShieldCheck } from 'lucide-react';
import { api, errorText, post, setSessionToken } from '../api';
import type { Session } from '../types';
import Brand from './Brand';

export default function Auth({ session, onSession }: { session: Session; onSession: (session: Session) => void }) {
  const invite = new URLSearchParams(window.location.search).get('invite');
  const setup = session.needsSetup && !invite;
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  useEffect(() => { if (invite) api<{email?: string}>(`/auth/invite?token=${encodeURIComponent(invite)}`).then(result => setEmail(result.email || '')).catch(err => setError(errorText(err))); }, [invite]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(true); setError('');
    try {
      const body = Object.fromEntries(form.entries());
      await post(setup ? '/auth/setup' : invite ? '/auth/invite/accept' : '/auth/login', invite ? { ...body, token: invite } : body);
      const next = await api<Session>('/auth/session'); setSessionToken(next); onSession(next);
      if (invite) { const url = new URL(window.location.href); url.searchParams.delete('invite'); history.replaceState({}, '', url); }
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return <div className="auth-page"><div className="auth-brand"><Brand /></div><div className="auth-card"><div className="auth-icon"><LockKeyhole size={25}/></div><span className="eyebrow">YOUR PRIVATE WORKSPACE</span><h1>{setup ? '开启你的 AI 工作空间' : invite ? '加入工作空间' : '欢迎回来'}</h1><p className="muted auth-description">{setup ? '创建管理员账号，连接你的 API 和模型。' : invite ? '你已收到邀请。设置账号后即可开始对话。' : '登录，继续你的想法。'}</p><form onSubmit={submit} className="stack">{setup && <label>管理员设置码<input name="setupToken" required autoComplete="off" placeholder="查看服务器首次启动日志"/><span className="field-help">设置码仅显示在服务器控制台中。</span></label>}{(setup || invite) && <label>怎么称呼你<input name="name" required maxLength={60} autoComplete="name" placeholder="你的名字"/></label>}<label>邮箱地址<input name="email" type="email" required autoComplete="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)}/></label><label>密码<input name="password" type="password" required maxLength={256} minLength={setup || invite ? 12 : 1} autoComplete={setup || invite ? 'new-password' : 'current-password'} placeholder={setup || invite ? '至少 12 个字符' : '输入你的密码'}/></label>{error && <div className="alert error" role="alert">{error}</div>}<button className="button primary auth-submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18}/> : <>{setup ? '创建工作空间' : invite ? '接受邀请' : '登录'}<ArrowRight size={17}/></>}</button></form><div className="auth-note"><ShieldCheck size={15}/><span>仅限你和受邀成员使用</span></div></div><footer className="auth-footer">连接自己的模型，让想法自由生长。</footer></div>;
}
