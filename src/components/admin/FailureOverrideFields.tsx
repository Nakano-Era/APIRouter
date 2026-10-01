import type { AdminModel } from '../../types';

export function failureOverrideValues(form: FormData) {
  const enabled = form.get('failureProtectionEnabled');
  return { failureProtectionEnabled: enabled === 'inherit' ? null : enabled === 'true', failureThreshold: form.get('failureThreshold') ? Number(form.get('failureThreshold')) : null, cooldownSeconds: form.get('cooldownMinutes') ? Math.round(Number(form.get('cooldownMinutes')) * 60) : null };
}
export default function FailureOverrideFields({ model }: { model: AdminModel }) {
  return <details className="model-failure-settings"><summary>失败冷却（此上游模型）</summary><div className="stack" style={{ marginTop: 14 }}><label>自动冷却<select name="failureProtectionEnabled" defaultValue={model.failureProtectionEnabled == null ? 'inherit' : String(model.failureProtectionEnabled)}><option value="inherit">继承渠道设置</option><option value="true">开启</option><option value="false">关闭</option></select></label><div className="form-grid"><label>连续失败次数<input type="number" name="failureThreshold" min={1} max={1000} step={1} defaultValue={model.failureThreshold ?? ''} placeholder="留空继承渠道"/></label><label>冷却时长（分钟）<input type="number" name="cooldownMinutes" min={1 / 60} max={43200} step="any" defaultValue={model.cooldownSeconds == null ? '' : model.cooldownSeconds / 60} placeholder="留空继承渠道"/></label></div><p className="field-help">关闭只取消失败后的临时冷却，不影响渠道切换。留空的次数和时长继承渠道。</p></div></details>;
}
