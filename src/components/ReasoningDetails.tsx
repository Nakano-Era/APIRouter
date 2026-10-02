import { Brain, ChevronRight, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import MathMarkdown from './MathMarkdown';
import type { Message } from '../types';

export default function ReasoningDetails({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  if (!message.reasoning) return null;
  const thinking = message.status === 'streaming' && !message.content;
  return <details className="message-reasoning" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{thinking ? <LoaderCircle size={14} className="spin"/> : <Brain size={14}/>}<span>{thinking ? '正在处理' : '思考与过程'}</span><ChevronRight className="reasoning-chevron" size={14}/></summary>
    {expanded && <div className="reasoning-content"><MathMarkdown components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>, img: ({ alt, src }) => <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noopener noreferrer">{alt || '查看图片'}</a>, table: ({ children }) => <div className="table-scroll"><table>{children}</table></div> }}>{message.reasoning}</MathMarkdown></div>}
  </details>;
}
