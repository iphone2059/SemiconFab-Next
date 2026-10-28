import type { FormEvent } from 'react';
import type { SiteDto } from '../../../contracts';
import { Panel } from '../../../components/ui';
import type { WorkbenchFormState } from '../state/workbenchStore';

export interface RunFormProps {
  site: SiteDto;
  form: WorkbenchFormState;
  submitting: boolean;
  submitError: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onFieldChange: (field: keyof WorkbenchFormState, value: string) => void;
}

/** New-simulation form; submission is executed by useRunSubmission. */
export function RunForm({
  site,
  form,
  submitting,
  submitError,
  onSubmit,
  onFieldChange,
}: RunFormProps) {
  const { lotCount, processTimeUs, durationUs, warmupUs, masterSeed } = form;
  return (
    <div className="workbench-run-form">
      <Panel title="新建仿真" subtitle={`${site.fabs.length} 个 FAB · 独立执行域。`}>
        <form onSubmit={onSubmit}>
          <div className="model-label">◇ 合成 FIFO · 单设备加工模型</div>
          <div className="field-grid">
            <label>
              Lot 数
              <input
                value={lotCount}
                onChange={(event) => onFieldChange('lotCount', event.target.value)}
                inputMode="numeric"
                required
              />
            </label>
            <label>
              单 Lot 加工 / μs
              <input
                value={processTimeUs}
                onChange={(event) => onFieldChange('processTimeUs', event.target.value)}
                inputMode="numeric"
                required
              />
            </label>
            <label>
              仿真时域 / μs
              <input
                value={durationUs}
                onChange={(event) => onFieldChange('durationUs', event.target.value)}
                inputMode="numeric"
                required
              />
            </label>
            <label>
              预热时长 / μs
              <input
                value={warmupUs}
                onChange={(event) => onFieldChange('warmupUs', event.target.value)}
                inputMode="numeric"
                required
              />
            </label>
          </div>
          <label>
            主随机种子
            <input
              value={masterSeed}
              onChange={(event) => onFieldChange('masterSeed', event.target.value)}
              inputMode="numeric"
              required
            />
          </label>
          <p className="form-note">
            整数微秒 · 权威 DES 在后端执行
            <br />
            不包含共享产能或真实工艺模型。
          </p>
          {submitError && (
            <div className="error" role="alert">
              {submitError}
            </div>
          )}
          <button className="primary" disabled={submitting || site.fabs.length === 0}>
            {submitting ? '正在提交…' : '创建并运行'}
            <span>↗</span>
          </button>
        </form>
      </Panel>
    </div>
  );
}
