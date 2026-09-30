import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BookOpen, Brain, BriefcaseBusiness, Check, ChevronDown, Download, Globe, MessageCircle } from 'lucide-react';
import type { ChatMode, Model, WorkCapabilities } from '../types';

export const effortLabels: Record<string, string> = { auto: '自动', low: '快速', medium: '标准', high: '深入', xhigh: '更深入', max: '最大' };
const effortDescriptions: Record<string, string> = { auto: '由模型决定合适的思考方式', low: '更快给出回答', medium: '兼顾速度与推理', high: '为复杂问题投入更多思考', xhigh: '进一步增加推理深度', max: '使用模型支持的最高思考强度' };
function Picker({ label, icon, children, disabled = false, active = false }: { label: string; icon: ReactNode; children: (close: () => void) => ReactNode; disabled?: boolean; active?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function outside(event: MouseEvent) { if (!ref.current?.contains(event.target as Node)) setOpen(false); }
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') { setOpen(false); ref.current?.querySelector<HTMLButtonElement>('button')?.focus(); } }
    document.addEventListener('mousedown', outside);
    if (open) document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <div ref={ref} className="task-picker"><button type="button" className={`task-pill ${active ? 'selected' : ''}`} aria-label={label} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} disabled={disabled}>{icon}<span>{label}</span><ChevronDown size={12}/></button>{open && <div className="task-menu popover" role="dialog" aria-label={label}>{children(() => setOpen(false))}</div>}</div>;
}
interface Props {
  mode: ChatMode; onMode: (value: ChatMode) => void; model?: Model; effort: string; onEffort: (value: string) => void;
  capabilities: WorkCapabilities | null; skillIds: string[]; onSkills: (ids: string[]) => void;
  webSearch: boolean; onWebSearch: (value: boolean) => void; disabled: boolean;
}
export default function ChatControls({ mode, onMode, model, effort, onEffort, capabilities, skillIds, onSkills, webSearch, onWebSearch, disabled }: Props) {
  const efforts = ['auto', ...new Set((model?.reasoningEfforts || []).filter(value => value !== 'auto'))];
  return <>
    <Picker label={mode === 'work' ? 'Work' : 'Chat'} icon={mode === 'work' ? <BriefcaseBusiness size={15}/> : <MessageCircle size={15}/>} disabled={disabled} active={mode === 'work'}>{close => <>
      <div className="menu-heading">工作方式</div>
      <button className={`task-option ${mode === 'chat' ? 'chosen' : ''}`} onClick={() => { onMode('chat'); close(); }}><MessageCircle size={19}/><span><strong>Chat</strong><small>问答、写作与日常交流</small></span>{mode === 'chat' && <Check size={16}/>}</button>
      <button className={`task-option ${mode === 'work' ? 'chosen' : ''}`} onClick={() => { onMode('work'); close(); }}><BriefcaseBusiness size={19}/><span><strong>Work</strong><small>使用工具、技能和工作区完成任务</small></span>{mode === 'work' && <Check size={16}/>}</button>
    </>}</Picker>
    <Picker label={`思考 · ${effortLabels[effort] || effort}`} icon={<Brain size={15}/>} disabled={disabled || !model}>{close => <>
      <div className="menu-heading">思考强度</div>
      {efforts.map(value => <button className={`task-option ${effort === value ? 'chosen' : ''}`} key={value} onClick={() => { onEffort(value); close(); }}><span><strong>{effortLabels[value] || value}</strong><small>{effortDescriptions[value] || '使用模型提供的思考选项'}</small></span>{effort === value && <Check size={16}/>}</button>)}
      {efforts.length === 1 && <p className="task-menu-note">此模型尚未配置可调整的思考强度。</p>}
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
