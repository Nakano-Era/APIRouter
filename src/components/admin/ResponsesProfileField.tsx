import type { Provider } from '../../types';

type Profile = NonNullable<Provider['responsesProfile']>;
export default function ResponsesProfileField({ value, onChange }: { value: Profile; onChange: (profile: Profile) => void }) {
  return <label>请求格式<select value={value} onChange={event => onChange(event.target.value as Profile)}><option value="auto">自动识别</option><option value="standard">标准 Responses</option><option value="codex">Codex 兼容</option></select><span className="field-help">自动识别：anyrouter.top 使用 Codex 兼容格式，其他地址使用标准 Responses。兼容格式无需安装 Codex CLI，单次输出上限由上游决定；上游仍可能限制专属令牌或客户端准入。</span></label>;
}
