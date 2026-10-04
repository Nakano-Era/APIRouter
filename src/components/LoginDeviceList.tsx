import type { ReactNode } from 'react';
import { CircleHelp, Monitor, Smartphone, Tablet } from 'lucide-react';
import type { LoginSession } from '../types';
import './login-devices.css';

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知时间' : date.toLocaleString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const deviceTypes = {
  desktop: { label: '电脑', icon: Monitor },
  mobile: { label: '手机', icon: Smartphone },
  tablet: { label: '平板', icon: Tablet },
  unknown: { label: '未知', icon: CircleHelp },
};

export function LoginDeviceLocationNotes() {
  return <>
    <p className="field-help login-devices-location-note">IP 与属地记录的是登录时的网络信息，属地为近似位置。旧登录记录可能没有这些信息。</p>
    <p className="field-help login-devices-location-note">属地数据：<a href="https://www.maxmind.com/" target="_blank" rel="noreferrer">MaxMind GeoLite2</a></p>
  </>;
}

export default function LoginDeviceList({ sessions, renderAction }: { sessions: LoginSession[]; renderAction?: (session: LoginSession) => ReactNode }) {
  return <ul className="login-devices-list" aria-label="已登录设备">{sessions.map(session => {
    const device = deviceTypes[session.deviceType] || deviceTypes.unknown;
    const DeviceIcon = device.icon;
    return <li key={session.id} className="login-device">
      <span className="login-device-icon" aria-hidden="true"><DeviceIcon size={20}/></span>
      <div className="login-device-details">
        <div className="login-device-name"><strong>{session.deviceName || '未知设备'}</strong>{session.current && <span className="role-badge">当前设备</span>}</div>
        <span>设备类型：{device.label}</span>
        <span>登录 IP：<bdi className="login-device-ip">{session.loginIp || '未记录'}</bdi></span>
        <span>IP 属地：{session.geoLocation || '未记录'}</span>
        <span>最近活动：{dateLabel(session.lastSeenAt)}</span>
        <span>登录时间：{dateLabel(session.createdAt)}</span>
      </div>
      {renderAction?.(session)}
    </li>;
  })}</ul>;
}
