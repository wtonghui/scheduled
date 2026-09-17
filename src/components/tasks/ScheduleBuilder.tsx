"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { isValidCron } from "@/lib/cron";
import {
  REPEAT_MODES,
  type ScheduleSpec,
  WEEKDAY_LABELS,
  buildSchedule,
  defaultSpec,
  describeSpec,
  nextRunPreview,
  parseCronToSpec,
  parseNaturalLanguage,
} from "@/lib/schedule-builder";
import { useMemo, useState } from "react";

/**
 * 结构化调度构建器：自然语言快捷 + 重复方式 + 时间 → cron/interval，
 * 实时预览下次运行；「高级」展开原始 cron。
 * 逻辑函数（buildSchedule/parseNaturalLanguage/describeSpec/nextRunPreview）保持不动。
 *
 * defaultValue 用于编辑场景预填：
 *  - cron 存在 → 直接进入「高级」模式并预填该表达式；
 *  - scheduleIntervalSeconds 存在 → 由父组件接管（结构化器不表达秒级间隔）。
 */

export interface ScheduleResult {
  cron?: string;
  scheduleIntervalSeconds?: number;
}

/** 服务端测算预览（父表单统一拉取后透传，避免两处各调一次）。 */
export interface ServerPreview {
  runs: { scheduledAt: string; holidayAdjusted: boolean }[];
  stopped: string | null;
}

/** stopped 原因文案（表单两处共用）。 */
export function stoppedLabel(stopped: string | null): string {
  if (stopped === "maxRuns") return "（次数已用完）";
  if (stopped === "endsAt") return "（已过截止）";
  if (stopped) return "（无后续计划）";
  return "";
}

interface Props {
  onChange: (result: ScheduleResult) => void;
  defaultValue?: ScheduleResult;
  /** 服务端测算（有则优先展示，无则回退本地 cron 推导）。 */
  serverPreview?: ServerPreview | null;
}

export default function ScheduleBuilder({ onChange, defaultValue, serverPreview }: Props) {
  /**
   * 编辑回填：cron 能映射回结构化 → 以该 spec 为初始值，
   * 「回到结构化选择」即对应到原重复方式/时间；否则保持默认。
   */
  const [spec, setSpec] = useState<ScheduleSpec>(() => {
    const parsed = defaultValue?.cron ? parseCronToSpec(defaultValue.cron) : null;
    return parsed ?? defaultSpec();
  });
  const [nlText, setNlText] = useState("");
  const [nlError, setNlError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(() => Boolean(defaultValue?.cron));
  const [rawCron, setRawCron] = useState(() => defaultValue?.cron ?? "");

  /**
   * 任何结构化改动立即回传给父表单。
   * （否则父表单的 schedule 停留在初始默认值，提交入库的是错误 cron。）
   */
  const set = (patch: Partial<ScheduleSpec>) => {
    const next = { ...spec, ...patch };
    setSpec(next);
    onChange(buildSchedule(next) ?? {});
  };

  const built = useMemo(() => buildSchedule(spec), [spec]);
  const next = useMemo(() => (built ? nextRunPreview(spec) : null), [spec, built]);
  const rawValid = useMemo(() => (advanced ? isValidCron(rawCron) : true), [advanced, rawCron]);
  /** 高级模式下原始 cron 能否映射回结构化（可映射才提供「回到结构化选择」）。 */
  const parsedSpec = useMemo(
    () => (advanced ? parseCronToSpec(rawCron) : null),
    [advanced, rawCron],
  );

  /** 退出高级模式：用当前 rawCron 对应的结构化 spec 回填控件，并回传父表单。 */
  const exitAdvanced = () => {
    if (!parsedSpec) return;
    setSpec(parsedSpec);
    setAdvanced(false);
    onChange(buildSchedule(parsedSpec) ?? {});
  };

  /** 「高级」模式下把原始 cron 同步给父表单；无效则清空。 */
  const handleRawCron = (value: string) => {
    setRawCron(value);
    onChange(isValidCron(value) ? { cron: value } : {});
  };

  /** 切到高级模式并预填当前结构化生成的 cron。 */
  const enterAdvanced = () => {
    const b = buildSchedule(spec);
    if (b?.cron) {
      setRawCron(b.cron);
      setAdvanced(true);
      onChange({ cron: b.cron });
    } else {
      setAdvanced(true);
    }
  };

  const handleNl = () => {
    const parsed = parseNaturalLanguage(nlText);
    if (parsed) {
      set(parsed);
      setNlError(null);
    } else {
      setNlError("无法识别，请手动选择或使用「高级」直接填写 cron");
    }
  };

  return (
    <div className="space-y-3">
      {/* 自然语言快捷 */}
      <div className="flex items-center gap-2">
        <Input
          value={nlText}
          onChange={(e) => {
            setNlText(e.target.value);
            setNlError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleNl();
            }
          }}
          placeholder="快捷输入：如「每天凌晨3点」「工作日上午9点」「每10分钟」"
          className="flex-1"
        />
        <Button type="button" variant="secondary" size="sm" onClick={handleNl}>
          解析
        </Button>
      </div>
      {nlError && (
        <div
          role="alert"
          className="rounded-md border border-bad/40 bg-bad-soft px-3 py-2 text-[13px] text-bad"
        >
          {nlError}
        </div>
      )}

      {advanced ? (
        <Card className="space-y-2.5 bg-surface-sunken/50 p-3">
          <div>
            <Label htmlFor="sb-raw-cron">原始 cron（5/6/7 段，7 段末位为年，UTC）</Label>
            <Input
              id="sb-raw-cron"
              value={rawCron}
              onChange={(e) => handleRawCron(e.target.value)}
              placeholder="*/5 * * * *  或  0 */5 * * * *"
              className="mt-1.5 font-mono text-xs"
            />
          </div>
          {!rawValid && (
            <div
              role="alert"
              className="rounded-md border border-bad/40 bg-bad-soft px-3 py-2 text-[13px] text-bad"
            >
              cron 表达式无效
            </div>
          )}
          {parsedSpec && (
            <Button type="button" variant="ghost" size="sm" onClick={exitAdvanced}>
              回到结构化选择
            </Button>
          )}
        </Card>
      ) : (
        <Card className="space-y-3 bg-surface-sunken/50 p-3">
          {/* 重复方式 */}
          <div className="max-w-60">
            <Label>重复方式</Label>
            <Select
              value={spec.mode}
              onValueChange={(v) => set({ mode: v as ScheduleSpec["mode"] })}
              className="mt-1.5"
              options={REPEAT_MODES.map((m) => ({ value: m.value, label: m.label }))}
            />
          </div>

          {spec.mode === "minute" && (
            <div className="max-w-60">
              <Label>每隔（分钟）</Label>
              <Input
                type="number"
                min={1}
                max={59}
                value={spec.minuteInterval}
                onChange={(e) => set({ minuteInterval: Number(e.target.value) || 1 })}
                className="mt-1.5"
              />
            </div>
          )}

          {spec.mode === "hour" && (
            <div className="flex gap-3">
              <div className="max-w-40">
                <Label>每隔（小时）</Label>
                <Input
                  type="number"
                  min={1}
                  max={23}
                  value={spec.hourInterval}
                  onChange={(e) => set({ hourInterval: Number(e.target.value) || 1 })}
                  className="mt-1.5"
                />
              </div>
              <div className="max-w-40">
                <Label>第几分钟执行</Label>
                <Input
                  type="number"
                  min={0}
                  max={59}
                  value={spec.minuteOfHour}
                  onChange={(e) => set({ minuteOfHour: Number(e.target.value) || 0 })}
                  className="mt-1.5"
                />
              </div>
            </div>
          )}

          {(spec.mode === "day" ||
            spec.mode === "weekday" ||
            spec.mode === "week" ||
            spec.mode === "month" ||
            spec.mode === "interval") && (
            <TimePicker
              hour={spec.hourOfDay}
              minute={spec.minuteOfHour}
              onHour={(h) => set({ hourOfDay: h })}
              onMinute={(m) => set({ minuteOfHour: m })}
            />
          )}

          {spec.mode === "week" && (
            <div>
              <Label>星期</Label>
              <div className="mt-1.5 flex items-center gap-4">
                {WEEKDAY_LABELS.map((label, i) => (
                  <div key={label} className="flex items-center gap-1.5">
                    <Checkbox
                      id={`sb-wd-${label}`}
                      checked={spec.weekDays.includes(i)}
                      onCheckedChange={(c) => {
                        const next = c
                          ? [...spec.weekDays, i]
                          : spec.weekDays.filter((d) => d !== i);
                        set({ weekDays: next });
                      }}
                    />
                    <Label htmlFor={`sb-wd-${label}`} className="cursor-pointer text-[13px]">
                      {label}
                    </Label>
                  </div>
                ))}
              </div>
            </div>
          )}

          {spec.mode === "month" && (
            <div className="max-w-60">
              <Label>每月几号</Label>
              <Input
                type="number"
                min={1}
                max={31}
                value={spec.dayOfMonth}
                onChange={(e) => set({ dayOfMonth: Number(e.target.value) || 1 })}
                className="mt-1.5"
              />
            </div>
          )}

          {spec.mode === "interval" && (
            <div className="max-w-72">
              <Label>每隔（天）</Label>
              <Input
                type="number"
                min={1}
                max={31}
                value={spec.dayInterval}
                onChange={(e) => set({ dayInterval: Number(e.target.value) || 1 })}
                className="mt-1.5"
              />
              <p className="mt-1 text-xs text-text-faint">每月第 1/1+N/… 号（≈每 N 天）</p>
            </div>
          )}

          <div className="pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={enterAdvanced}>
              高级（手动 cron）
            </Button>
          </div>
        </Card>
      )}

      {/* 实时预览 */}
      <Card className="space-y-1.5 bg-accent-soft/60 p-3 text-[13px]">
        <div className="flex items-center gap-2">
          <Badge tone="neutral">调度</Badge>
          <code className="text-xs">{advanced ? rawCron || "—" : (built?.cron ?? "—")}</code>
        </div>
        {!advanced && built && (
          <>
            <div className="flex items-center gap-2">
              <Badge tone="neutral">说明</Badge>
              <span className="text-text-secondary">{describeSpec(spec)}</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone="neutral">下次运行</Badge>
              {serverPreview?.runs[0] ? (
                <>
                  <code className="text-xs">
                    {new Date(serverPreview.runs[0].scheduledAt).toLocaleString()}
                  </code>
                  {serverPreview.runs[0].holidayAdjusted ? (
                    <span className="text-[12px] text-text-muted">（节假日调整）</span>
                  ) : null}
                </>
              ) : serverPreview ? (
                <span className="text-text-faint">—{stoppedLabel(serverPreview.stopped)}</span>
              ) : next ? (
                <>
                  <code className="text-xs">{next.toLocaleString()}</code>
                  <span className="text-[12px] text-text-muted">
                    （约 {Math.round(((next.getTime() - Date.now()) / 3600000) * 10) / 10} 小时后）
                  </span>
                </>
              ) : (
                <span className="text-text-faint">—</span>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function TimePicker(props: {
  hour: number;
  minute: number;
  onHour: (h: number) => void;
  onMinute: (m: number) => void;
}) {
  return (
    <div className="flex gap-3">
      <div className="max-w-40">
        <Label>时（UTC）</Label>
        <Input
          type="number"
          min={0}
          max={23}
          value={props.hour}
          onChange={(e) => props.onHour(Math.min(23, Math.max(0, Number(e.target.value) || 0)))}
          className="mt-1.5"
        />
      </div>
      <div className="max-w-40">
        <Label>分</Label>
        <Input
          type="number"
          min={0}
          max={59}
          value={props.minute}
          onChange={(e) => props.onMinute(Math.min(59, Math.max(0, Number(e.target.value) || 0)))}
          className="mt-1.5"
        />
      </div>
    </div>
  );
}
