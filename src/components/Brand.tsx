import { Layers2 } from 'lucide-react';
export default function Brand({ compact = false }: { compact?: boolean }) { return <div className="brand"><span className="brand-mark"><Layers2 size={21} strokeWidth={1.8} /></span>{!compact && <span>APIRouter<span className="brand-caption">个人 AI 工作空间</span></span>}</div>; }
