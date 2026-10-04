import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, LoaderCircle, LogOut, RefreshCw } from 'lucide-react';
import { api, errorText, post, remove } from '../api';
import type { LoginSession } from '../types';
import LoginDeviceList, { LoginDeviceLocationNotes } from './LoginDeviceList';
import './login-devices.css';

export default function LoginDevices({ refreshKey = 0, disabled = false }: { refreshKey?: number; disabled?: boolean }) {
  const headingId = useId();
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
  return <section className="login-devices" aria-labelledby={headingId}>
    <div className="login-devices-heading"><h4 id={headingId}>登录设备</h4><button type="button" className="button small" disabled={locked} onClick={() => { setNotice(''); void reload(); }} aria-label="刷新登录设备">{loading ? <LoaderCircle size={14} className="spin"/> : <RefreshCw size={14}/>}刷新</button></div>
    <p className="field-help">登录长期有效。同一账号可以在多台设备同时登录。账号菜单中的退出登录只退出当前浏览器；修改密码会退出其他设备。</p>
    <LoginDeviceLocationNotes/>
    {error && <div className="alert error" role="alert"><span>{error}</span><button type="button" className="button small" disabled={locked} onClick={() => void reload()}>重试</button></div>}
    {notice && <div className="alert success" role="status"><Check size={15}/>{notice}</div>}
    {!loaded && loading && <p className="login-devices-loading" role="status"><LoaderCircle size={16} className="spin"/>正在读取登录设备…</p>}
    {loaded && sessions.length > 0 && <LoginDeviceList sessions={sessions} renderAction={session => !session.current && <button type="button" className="button small login-device-revoke" disabled={locked} onClick={() => void revoke(session.id)} aria-label={`退出设备 ${session.deviceName || '未知设备'}`}>{busy === session.id ? <LoaderCircle size={14} className="spin"/> : <LogOut size={14}/>}退出</button>}/>}
    {loaded && !sessions.length && <p className="field-help">暂无有效登录设备，请刷新后重试。</p>}
    {loaded && <div className="login-devices-footer"><button type="button" className="button small" disabled={locked || otherCount === 0} onClick={() => void revoke()}>{busy === 'others' ? <LoaderCircle size={14} className="spin"/> : <LogOut size={14}/>}退出其他所有设备</button><span>{otherCount ? `另有 ${otherCount} 个登录设备` : '目前仅此设备登录'}</span></div>}
  </section>;
}
