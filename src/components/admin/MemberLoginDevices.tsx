import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { api, errorText } from '../../api';
import type { LoginSession, User } from '../../types';
import LoginDeviceList, { LoginDeviceLocationNotes } from '../LoginDeviceList';

function MemberLoginDeviceDetails({ user }: { user: User }) {
  const headingId = useId();
  const [sessions, setSessions] = useState<LoginSession[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const request = useRef(0);
  const mounted = useRef(false);

  const reload = useCallback(async () => {
    const sequence = ++request.current;
    setLoading(true); setError('');
    try {
      const result = await api<{ sessions: LoginSession[] }>(`/admin/users/${encodeURIComponent(user.id)}/sessions`);
      if (mounted.current && sequence === request.current) { setSessions(result.sessions); setLoaded(true); }
    } catch (cause) {
      if (mounted.current && sequence === request.current) setError(errorText(cause));
    } finally {
      if (mounted.current && sequence === request.current) setLoading(false);
    }
  }, [user.id]);

  useEffect(() => {
    mounted.current = true; void reload();
    return () => { mounted.current = false; request.current++; };
  }, [reload]);

  return <section className="login-devices" aria-labelledby={headingId}>
    <div className="login-devices-heading"><h4 id={headingId}>{user.name} 的登录设备</h4><button type="button" className="button small" disabled={loading} onClick={() => void reload()} aria-label={`刷新 ${user.name} 的登录设备`}>{loading ? <LoaderCircle size={14} className="spin"/> : <RefreshCw size={14}/>}刷新</button></div>
    <p className="field-help">登录长期有效。这里显示该成员仍有效的登录设备；已退出的设备不会列出。</p>
    <LoginDeviceLocationNotes/>
    {error && <div className="alert error" role="alert"><span>{error}</span><button type="button" className="button small" disabled={loading} onClick={() => void reload()}>重试</button></div>}
    {!loaded && loading && <p className="login-devices-loading" role="status"><LoaderCircle size={16} className="spin"/>正在读取登录设备…</p>}
    {loaded && sessions.length > 0 && <LoginDeviceList sessions={sessions}/>}
    {loaded && !sessions.length && <p className="field-help">该成员暂无有效登录设备。</p>}
  </section>;
}

export default function MemberLoginDevices({ user }: { user: User }) {
  const summaryId = useId();
  const [expanded, setExpanded] = useState(false);
  return <details className="member-login-devices" aria-labelledby={summaryId} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary id={summaryId} aria-label={`查看 ${user.name} 的登录设备`}>登录设备</summary>
    {expanded && <MemberLoginDeviceDetails key={user.id} user={user}/>}
  </details>;
}
