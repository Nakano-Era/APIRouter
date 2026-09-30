import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, ChevronDown, ChevronRight, Eye, Search, SlidersHorizontal } from 'lucide-react';
import type { Model } from '../types';
import { effortLabels } from './ChatControls';

export default function ModelPicker({ models, value, onChange, effort, onEffort, disabled, isAdmin, onSettings }: { models: Model[]; value: string; onChange: (id: string) => void; effort: string; onEffort: (value: string) => void; disabled: boolean; isAdmin: boolean; onSettings: () => void }) {
  const [open, setOpen] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null); const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const selected = models.find(model => model.id === value);
  const efforts = ['auto', ...new Set((selected?.reasoningEfforts || []).filter(option => option !== 'auto'))];
  const filtered = models.filter(model => `${model.name} ${model.modelId}`.toLowerCase().includes(query.toLowerCase()));
  function close(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }));
  }
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const target = showModels
        ? panel.current?.querySelector<HTMLElement>('input') || panel.current?.querySelector<HTMLElement>('.model-option.chosen')
        : panel.current?.querySelector<HTMLElement>('.effort-option.chosen');
      (target || panel.current?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, showModels]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const bounds = ref.current?.getBoundingClientRect(); if (!bounds) return;
      const width = Math.min(304, window.innerWidth - 24); const above = bounds.top > 245;
      setPosition({ position: 'fixed', width, left: Math.max(12, Math.min(bounds.right - width, window.innerWidth - width - 12)), top: above ? 'auto' : bounds.bottom + 9, bottom: above ? window.innerHeight - bounds.top + 9 : 'auto', maxHeight: Math.min(480, above ? bounds.top - 25 : window.innerHeight - bounds.bottom - 25), visibility: 'visible' });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    const outside = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && open) { event.preventDefault(); close(); } };
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <div className="model-picker composer-model-picker" ref={ref}>
    <button className="model-trigger" onClick={() => { setOpen(!open); setShowModels(!selected); setQuery(''); }} disabled={disabled} title={`${selected?.name || '选择模型'} · 思考${effortLabels[effort] || effort}`} aria-label="选择模型与思考强度" aria-haspopup="dialog" aria-expanded={open}><span className="model-trigger-name">{selected?.name || '选择模型'}</span>{effort !== 'auto' && <span className="model-effort-label">{effortLabels[effort] || effort}</span>}<ChevronDown size={13} className={open ? 'rotated' : ''}/></button>
    {open && createPortal(<div ref={panel} className="model-menu unified-model-menu popover" style={position} role="dialog" aria-label={showModels ? '选择模型' : '模型与思考强度'}>
      {showModels ? <>
        <button className="model-menu-back" onClick={() => setShowModels(false)}><ArrowLeft size={15}/><span>选择模型</span></button>
        {models.length > 4 && <div className="search-input"><Search size={15}/><input autoFocus aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={event => setQuery(event.target.value)}/></div>}
        <div className="model-options">{filtered.map(model => <button className={`model-option ${value === model.id ? 'chosen' : ''}`} key={model.id} onClick={() => { onChange(model.id); if (!model.reasoningEfforts?.includes(effort)) onEffort('auto'); setShowModels(false); }}><div><strong>{model.name}</strong><span>{model.vision ? <><Eye size={12}/> 支持图片</> : '文字与文档'}</span></div>{value === model.id && <Check size={16}/>}</button>)}{models.length > 0 && !filtered.length && <p className="menu-empty">没有找到这个模型。</p>}{!models.length && <p className="menu-empty">暂时没有启用的模型。{isAdmin ? '请先连接 API。' : '请联系管理员配置。'}</p>}</div>
      </> : <>
        <div className="model-menu-current"><strong>{selected?.name || '选择模型'}</strong><span>思考强度</span></div>
        {efforts.map(option => <button className={`effort-option ${effort === option ? 'chosen' : ''}`} key={option} onClick={() => { onEffort(option); close(); }}><span>{effortLabels[option] || option}</span>{effort === option && <Check size={16}/>}</button>)}
        <button className="model-menu-switch" onClick={() => setShowModels(true)}><span>切换模型</span><ChevronRight size={16}/></button>
      </>}
      {isAdmin && <button className="menu-footer" onClick={() => { close(false); onSettings(); }}><SlidersHorizontal size={15}/>管理模型</button>}
    </div>, document.body)}
  </div>;
}
