import { DEFAULT_TIMEZONE, computeNextRun } from "./cron";

/**
 * 结构化调度构建器：把「重复方式 + 时间」拆解成标准 cron / 固定间隔，
 * 替代让用户手敲 cron 表达式。纯函数、客户端安全（无 React/Node API）。
 *
 * 输出 { cron?, scheduleIntervalSeconds? } 直接喂给 CreateTaskSchema
 * （二者必选其一，见 src/modules/task/dto.ts）。
 */

export type RepeatMode = "minute" | "hour" | "day" | "week" | "weekday" | "month" | "interval";

export const REPEAT_MODES: Array<{ value: RepeatMode; label: string }> = [
  { value: "minute", label: "每 N 分钟" },
  { value: "hour", label: "每 N 小时" },
  { value: "day", label: "每天" },
  { value: "week", label: "每周" },
  { value: "weekday", label: "工作日" },
  { value: "month", label: "每月" },
  { value: "interval", label: "每 N 天" },
];

export const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

export interface ScheduleSpec {
  mode: RepeatMode;
  /** minute：每隔多少分钟（1..59） */
  minuteInterval: number;
  /** hour：每隔多少小时（1..23）；minuteOfHour 为整点偏移 */
  hourInterval: number;
  /** 分（0..59），用于 hour/day/week/weekday/month */
  minuteOfHour: number;
  /** 时（0..23），用于 day/week/weekday/month */
  hourOfDay: number;
  /** 星期（cron DOW：0=日 .. 6=六），用于 week */
  weekDays: number[];
  /** 每月几号（1..31） */
  dayOfMonth: number;
  /** interval：每多少天（1..365） */
  dayInterval: number;
}

export function defaultSpec(): ScheduleSpec {
  return {
    mode: "day",
    minuteInterval: 5,
    hourInterval: 1,
    minuteOfHour: 0,
    hourOfDay: 0,
    weekDays: [1, 2, 3, 4, 5],
    dayOfMonth: 1,
    dayInterval: 1,
  };
}

export interface BuiltSchedule {
  cron?: string;
  scheduleIntervalSeconds?: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** 结构化 spec → cron 或固定间隔；非法输入 → null。 */
export function buildSchedule(spec: ScheduleSpec): BuiltSchedule | null {
  const m = clamp(spec.minuteOfHour, 0, 59);
  const h = clamp(spec.hourOfDay, 0, 23);
  switch (spec.mode) {
    case "minute": {
      const n = clamp(spec.minuteInterval, 1, 59);
      if (n <= 0 || n > 59) return null;
      return { cron: `*/${n} * * * *` };
    }
    case "hour": {
      const n = clamp(spec.hourInterval, 1, 23);
      if (n <= 0 || n > 23) return null;
      return { cron: `${m} */${n} * * *` };
    }
    case "day":
      return { cron: `${m} ${h} * * *` };
    case "weekday":
      return { cron: `${m} ${h} * * 1-5` };
    case "week": {
      const days = [...new Set(spec.weekDays)].filter(
        (d) => Number.isInteger(d) && d >= 0 && d <= 6,
      );
      if (days.length === 0) return null;
      return { cron: `${m} ${h} * * ${days.sort((a, b) => a - b).join(",")}` };
    }
    case "month": {
      const d = clamp(spec.dayOfMonth, 1, 31);
      if (d < 1 || d > 31) return null;
      return { cron: `${m} ${h} ${d} * *` };
    }
    case "interval": {
      // cron 的 day-of-month 字段上限 31：*/N 表示每月 1、1+N、1+2N… 号（≈每 N 天）
      const n = clamp(spec.dayInterval, 1, 31);
      if (n <= 0 || n > 31) return null;
      return { cron: `${m} ${h} */${n} * *` };
    }
  }
}

/** spec → 中文可读描述。 */
export function describeSpec(spec: ScheduleSpec): string {
  const m = pad2(clamp(spec.minuteOfHour, 0, 59));
  const h = clamp(spec.hourOfDay, 0, 23);
  switch (spec.mode) {
    case "minute":
      return `每 ${clamp(spec.minuteInterval, 1, 59)} 分钟`;
    case "hour":
      return `每 ${clamp(spec.hourInterval, 1, 23)} 小时（${m} 分）`;
    case "day":
      return `每天 ${pad2(h)}:${m}`;
    case "weekday":
      return `工作日 ${pad2(h)}:${m}`;
    case "week": {
      const days = spec.weekDays
        .filter((d) => d >= 0 && d <= 6)
        .map((d) => `周${WEEKDAY_LABELS[d]}`)
        .join("、");
      return days ? `每周${days} ${pad2(h)}:${m}` : "每周（未选星期）";
    }
    case "month":
      return `每月 ${spec.dayOfMonth} 号 ${pad2(h)}:${m}`;
    case "interval":
      return `每 ${clamp(spec.dayInterval, 1, 31)} 天 ${pad2(h)}:${m}（每月第 1/${1 + clamp(spec.dayInterval, 1, 31)}/… 号）`;
  }
}

/** 下次运行时间（默认 Asia/Shanghai，可透传 IANA 时区）；无法计算 → null。 */
export function nextRunPreview(
  spec: ScheduleSpec,
  from = new Date(),
  timezone = DEFAULT_TIMEZONE,
): Date | null {
  const built = buildSchedule(spec);
  if (!built) return null;
  return computeNextRun(
    {
      cron: built.cron ?? null,
      scheduleIntervalSeconds: built.scheduleIntervalSeconds ?? null,
    },
    from,
    timezone,
  );
}

// ── cron → 结构化 spec 逆映射（编辑回显用） ──────────────────────────────

function fieldNumber(value: string, min: number, max: number): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * 步进字段解析：识别「星号·斜杠·数字」形态的步进（例如每 5 分钟），
 * 返回步进整数；范围不符 → null。
 * （说明：块注释内不写字面「星号斜杠」，否则会提前闭合注释。）
 */
function fieldStep(value: string, min: number, max: number): number | null {
  const m = value.match(/^\*\/(\d+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= min && n <= max ? n : null;
}

/** cron 星期字段 → 数字星期数组（支持 `1,3`、`0-4`、混合），失败 → null。 */
function weekdayList(value: string): number[] | null {
  const days: number[] = [];
  const parts = value.split(",");
  if (parts.some((p) => p === "")) return null;
  for (const part of parts) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      let a = Number(range[1]);
      let b = Number(range[2]);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      if (a > b) {
        const tmp = a;
        a = b;
        b = tmp;
      }
      if (a < 0 || b > 6) return null;
      for (let d = a; d <= b; d += 1) days.push(d);
    } else {
      const d = fieldNumber(part, 0, 6);
      if (d === null) return null;
      days.push(d);
    }
  }
  return days.length > 0 ? [...new Set(days)].sort((x, y) => x - y) : null;
}

/**
 * 5 段 cron → ScheduleSpec（buildSchedule 的逆映射，用于编辑时「回到结构化选择」回显）。
 * 无法用结构化器表达（6 段含秒、7 段含年、带月限制、日期与星期组合等）→ null。
 * 生成侧未覆盖的等价格式（如 `*` 分/时）按语义归一到结构化表达。
 */
export function parseCronToSpec(cron: string): ScheduleSpec | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  // 长度已校验；逐字段判空以适配 noUncheckedIndexedAccess 收窄
  const minField = fields[0];
  const hourField = fields[1];
  const domField = fields[2];
  const monField = fields[3];
  const dowField = fields[4];
  if (
    minField === undefined ||
    hourField === undefined ||
    domField === undefined ||
    monField === undefined ||
    dowField === undefined
  ) {
    return null;
  }
  if (monField !== "*") return null;
  const base = defaultSpec();

  // 每 N 分钟：分字段 `*/n`（或 `*`），其余通配
  if (hourField === "*" && domField === "*" && dowField === "*") {
    if (minField === "*") return { ...base, mode: "minute", minuteInterval: 1 };
    const n = fieldStep(minField, 1, 59);
    if (n !== null) return { ...base, mode: "minute", minuteInterval: n };
  }

  const minute = fieldNumber(minField, 0, 59);

  // 每 N 小时：第 minute 分执行
  if (minute !== null && domField === "*" && dowField === "*") {
    if (hourField === "*") {
      return { ...base, mode: "hour", hourInterval: 1, minuteOfHour: minute };
    }
    const n = fieldStep(hourField, 1, 23);
    if (n !== null) return { ...base, mode: "hour", hourInterval: n, minuteOfHour: minute };
  }

  const hour = fieldNumber(hourField, 0, 23);
  if (minute === null || hour === null) return null;

  // 每天 / 工作日 / 每周
  if (domField === "*") {
    if (dowField === "*") {
      return { ...base, mode: "day", hourOfDay: hour, minuteOfHour: minute };
    }
    if (dowField === "1-5") {
      return { ...base, mode: "weekday", hourOfDay: hour, minuteOfHour: minute };
    }
    const days = weekdayList(dowField);
    if (days !== null) {
      return { ...base, mode: "week", weekDays: days, hourOfDay: hour, minuteOfHour: minute };
    }
    return null;
  }

  // 每月 N 号 / 每 N 天
  if (dowField === "*") {
    const day = fieldNumber(domField, 1, 31);
    if (day !== null) {
      return { ...base, mode: "month", dayOfMonth: day, hourOfDay: hour, minuteOfHour: minute };
    }
    const n = fieldStep(domField, 1, 31);
    if (n !== null) {
      return { ...base, mode: "interval", dayInterval: n, hourOfDay: hour, minuteOfHour: minute };
    }
  }

  return null;
}

// ── 自然语言快捷解析（确定性正则，不调 LLM） ────────────────────────────

const TIME_RE = /(\d{1,2})(?::(\d{1,2}))?\s*(?:时|点)/;

function parseTime(text: string): { hour: number; minute: number } | null {
  const m = text.match(TIME_RE);
  if (!m) return null;
  let hour = Number(m[1]);
  let minute = m[2] ? Number(m[2]) : 0;
  if (m[2] === undefined && /点半/.test(text)) {
    minute = 30; // 如「8点半」
  }
  if (hour > 23 || minute > 59) return null;
  // 下午/晚上/傍晚 → +12
  if (/下午|晚上|傍晚/.test(text)) {
    if (hour < 12) hour += 12;
  }
  return { hour, minute };
}

function cnWeekdayToCron(w: string): number {
  const map: Record<string, number> = {
    日: 0,
    天: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
  };
  return map[w] ?? -1;
}

/**
 * 解析自然语言 → ScheduleSpec（全部字段齐全，可直接 buildSchedule）。
 * 命中失败 → null（UI 提示手动选择，不阻塞）。
 */
export function parseNaturalLanguage(text: string): ScheduleSpec | null {
  const s = text.trim();
  if (!s) return null;
  const base = defaultSpec();

  const minute = s.match(/每(\d{1,2})分钟/);
  if (minute) {
    const n = Number(minute[1]);
    if (n >= 1 && n <= 59) return { ...base, mode: "minute", minuteInterval: n };
    return null;
  }
  const hourEvery = s.match(/每(\d{1,2})小时/);
  if (hourEvery) {
    const n = Number(hourEvery[1]);
    if (n >= 1 && n <= 23) return { ...base, mode: "hour", hourInterval: n };
    return null;
  }
  const dayEvery = s.match(/每(\d{1,3})天/);
  if (dayEvery) {
    const n = Number(dayEvery[1]);
    if (n >= 1 && n <= 365) return { ...base, mode: "interval", dayInterval: n };
    return null;
  }

  const time = parseTime(s);
  if (!time) return null;

  const weekMatch = s.match(/周([日一二三四五六天])|星期([日一二三四五六天])/);
  if (weekMatch) {
    const w = weekMatch[1] ?? weekMatch[2];
    if (!w) return null;
    const dow = cnWeekdayToCron(w);
    if (dow < 0) return null;
    return {
      ...base,
      mode: "week",
      weekDays: [dow],
      hourOfDay: time.hour,
      minuteOfHour: time.minute,
    };
  }
  if (s.includes("工作日")) {
    return { ...base, mode: "weekday", hourOfDay: time.hour, minuteOfHour: time.minute };
  }
  const monthDay = s.match(/每月(\d{1,2})[号日]/);
  if (monthDay) {
    const d = Number(monthDay[1]);
    if (d >= 1 && d <= 31) {
      return {
        ...base,
        mode: "month",
        dayOfMonth: d,
        hourOfDay: time.hour,
        minuteOfHour: time.minute,
      };
    }
    return null;
  }
  if (s.includes("每天") || s.includes("每日")) {
    return { ...base, mode: "day", hourOfDay: time.hour, minuteOfHour: time.minute };
  }
  return null;
}
