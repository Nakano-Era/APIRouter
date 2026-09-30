import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, BriefcaseBusiness, Check, ChevronDown, Download, Globe, MessageCircle } from 'lucide-react';
import type { ChatMode, WorkCapabilities } from '../types';

export const effortLabels: Record<string, string> = { auto: '自动', low: '快速', medium: '标准', high: '深入', xhigh: '更深入', max: '最大' };
function Picker({ label, icon, children, disabled = false, active = false }: { label: string; icon: ReactNode; children: (close: () => void) => ReactNode; disabled?: boolean; active?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  function close(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }));
  }
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const target = panel.current?.querySelector<HTMLElement>('.task-option.chosen')
        || panel.current?.querySelector<HTMLElement>('input:checked:not(:disabled)')
        || panel.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]');
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const bounds = ref.current?.getBoundingClientRect(); if (!bounds) return;
      const width = Math.min(312, window.innerWidth - 24);
      const above = bounds.top > 245;
      setPosition({ position: 'fixed', width, left: Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12)), top: above ? 'auto' : bounds.bottom + 9, bottom: above ? window.innerHeight - bounds.top + 9 : 'auto', maxHeight: Math.min(440, above ? bounds.top - 25 : window.innerHeight - bounds.bottom - 25), visibility: 'visible' });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    function outside(event: MouseEvent) { if (!ref.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close(false); }
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') { event.preventDefault(); close(); } }
    document.addEventListener('mousedown', outside);
    if (open) document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <div ref={ref} className="task-picker"><button type="button" className={`task-pill ${active ? 'selected' : ''}`} aria-label={label} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} disabled={disabled}>{icon}<span>{label}</span><ChevronDown size={12}/></button>{open && createPortal(<div ref={panel} className="task-menu popover" style={position} role="dialog" aria-label={label}>{children(() => close())}</div>, document.body)}</div>;
}
interface Props {
  mode: ChatMode; onMode: (value: ChatMode) => void;
  capabilities: WorkCapabilities | null; skillIds: string[]; onSkills: (ids: string[]) => void;
  webSearch: boolean; onWebSearch: (value: boolean) => void; disabled: boolean;
}
export default function ChatControls({ mode, onMode, capabilities, skillIds, onSkills, webSearch, onWebSearch, disabled }: Props) {
  return <>
    <Picker label={mode === 'work' ? 'Work' : 'Chat'} icon={mode === 'work' ? <BriefcaseBusiness size={15}/> : <MessageCircle size={15}/>} disabled={disabled} active={mode === 'work'}>{close => <>
      <div className="menu-heading">工作方式</div>
      <button className={`task-option ${mode === 'chat' ? 'chosen' : ''}`} onClick={() => { onMode('chat'); close(); }}><MessageCircle size={19}/><span><strong>Chat</strong><small>问答、写作与日常交流</small></span>{mode === 'chat' && <Check size={16}/>}</button>
      <button className={`task-option ${mode === 'work' ? 'chosen' : ''}`} onClick={() => { onMode('work'); close(); }}><BriefcaseBusiness size={19}/><span><strong>Work</strong><small>使用工具、技能和工作区完成任务</small></span>{mode === 'work' && <Check size={16}/>}</button>
    </>}</Picker>
    {mode === 'work' && <>
      <button className={`task-pill task-tool ${webSearch ? 'selected' : ''}`} aria-label="网络搜索" aria-pressed={webSearch} title={capabilities?.webSearchSupported === false ? '当前服务尚未开启网络搜索' : '允许 Work 使用网络搜索'} disabled={disabled || !capabilities?.available || capabilities.webSearchSupported === false} onClick={() => onWebSearch(!webSearch)}><Globe size={15}/><span>搜索</span></button>
      <Picker label={`技能${skillIds.length ? ` · ${skillIds.length}` : ''}`} icon={<BookOpen size={15}/>} disabled={disabled || !capabilities?.available} active={skillIds.length > 0}>{() => <>
        <div className="menu-heading">本次任务使用的技能 <span>{skillIds.length}/10</span></div>
        <div className="task-skill-list">{(capabilities?.skills || []).map(skill => <div className="task-skill" key={skill.id}>
          <label><input type="checkbox" disabled={!skillIds.includes(skill.id) && skillIds.length >= 10} checked={skillIds.includes(skill.id)} onChange={event => onSkills(event.target.checked ? [...skillIds, skill.id] : skillIds.filter(id => id !== skill.id))}/><span><strong>{skill.name}</strong>{skill.description && <small>{skill.description}</small>}</span></label>
          <a href={`/api/work/skills/${encodeURIComponent(skill.id)}/download`} className="icon-button" aria-label={`下载技能 ${skill.name}`} title="下载 SKILL.md"><Download size={15}/></a>
        </div>)}</div>
        {!capabilities?.skills.length && <p className="task-menu-note">尚未添加技能，管理员可以在设置中的 Work 与技能页添加。</p>}
      </>}</Picker>
    </>}
  </>;
}
