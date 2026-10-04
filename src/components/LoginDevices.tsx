import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, LogOut, Monitor, RefreshCw, Smartphone } from 'lucide-react';
import { api, errorText, post, remove } from '../api';
import type { LoginSession } from '../types';
import './login-devices.css';

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知时间' : date.toLocaleString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function LoginDevices({ refreshKey = 0, disabled = false }: { refreshKey?: number; disabled?: boolean }) {
  const [sessions, setSessions] = useState<LoginSession[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef(0);
  const mutating = useRef(false);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    const sequence = ++request.current;
    setLoading(true); setError('');
    try {
      const result = await api<{ sessions: LoginSession[] }>('/auth/sessions');
      if (mounted.current && sequence === request.current) { setSessions(result.sessions); setLoaded(true); }
    } catch (cause) {
      if (mounted.current && sequence === request.current) setError(errorText(cause));
    } finally {
      if (mounted.current && sequence === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true; setNotice(''); void reload();
    return () => { mounted.current = false; request.current++; };
  }, [refreshKey, reload]);

  async function revoke(id?: string) {
    if (disabled || mutating.current || loading) return;
    mutating.current = true; setBusy(id || 'others'); setError(''); setNotice('');
    try {
      if (id) {
        await remove(`/auth/sessions/${encodeURIComponent(id)}`);
        if (mounted.current) { setSessions(current => current.filter(item => item.id !== id)); setNotice('该设备已退出登录。'); }
      } else {
        const result = await post<{ ok: boolean; revokedCount: number }>('/auth/sessions/logout-others');
        if (mounted.current) { setSessions(current => current.filter(item => item.current)); setNotice(`已退出其他 ${result.revokedCount} 个登录设备。`); }
      }
      if (mounted.current) await reload();
    } catch (cause) {
      if (mounted.current) setError(errorText(cause));
    } finally {
      mutating.current = false;
      if (mounted.current) setBusy('');
    }
  }

  const locked = disabled || loading || !!busy;
  const otherCount = sessions.filter(item => !item.current).length;
  return <section className="login-devices" aria-labelledby="login-devices-title">
    <div className="login-devices-heading"><h4 id="login-devices-title">登录设备</h4><button type="button" className="button small" disabled={locked} onClick={() => { setNotice(''); void reload(); }} aria-label="刷新登录设备">{loading ? <LoaderCircle size={14} className="spin"/> : <RefreshCw size={14}/>}刷新</button></div>
    <p className="field-help">同一账号可以在多台设备同时登录。账号菜单中的退出登录只退出当前浏览器；修改密码会退出其他设备。</p>
    {error && <div className="alert error" role="alert"><span>{error}</span><button type="button" className="button small" disabled={locked} onClick={() => void reload()}>重试</button></div>}
    {notice && <div className="alert success" role="status"><Check size={15}/>{notice}</div>}
    {!loaded && loading && <p className="login-devices-loading" role="status"><LoaderCircle size={16} className="spin"/>正在读取登录设备…</p>}
    {loaded && <ul className="login-devices-list" aria-label="已登录设备">{sessions.map(session => {
      const DeviceIcon = /android|iphone|ipad|ios|手机|平板/i.test(session.deviceName) ? Smartphone : Monitor;
      return <li key={session.id} className="login-device"><span className="login-device-icon"><DeviceIcon size={20}/></span><div className="login-device-details"><div className="login-device-name"><strong>{session.deviceName || '未知设备'}</strong>{session.current && <span className="role-badge">当前设备</span>}</div><span>最近活动：{dateLabel(session.lastSeenAt)}</span><span>登录时间：{dateLabel(session.createdAt)}</span><span>登录有效至：{dateLabel(session.expiresAt)}</span></div>{!session.current && <button type="button" className="button small login-device-revoke" disabled={locked} onClick={() => void revoke(session.id)} aria-label={`退出设备 ${session.deviceName || '未知设备'}`}>{busy === session.id ? <LoaderCircle size={14} className="spin"/> : <LogOut size={14}/>}退出</button>}</li>;
    })}</ul>}
    {loaded && !sessions.length && <p className="field-help">暂无有效登录设备，请刷新后重试。</p>}
    {loaded && <div className="login-devices-footer"><button type="button" className="button small" disabled={locked || otherCount === 0} onClick={() => void revoke()}>{busy === 'others' ? <LoaderCircle size={14} className="spin"/> : <LogOut size={14}/>}退出其他所有设备</button><span>{otherCount ? `另有 ${otherCount} 个登录设备` : '目前仅此设备登录'}</span></div>}
  </section>;
}
