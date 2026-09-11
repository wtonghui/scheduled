/**
 * 执行器注册表（NFR-006）：按 taskType 注册可执行器。
 */

export interface TaskExecutorInput {
  task: {
    id: string;
    taskType: "http" | "noop";
    payload: Record<string, unknown>;
    payloadSecrets: Uint8Array | null;
    timeoutMs: number;
    /** 任务执行请求签名密钥（加密字节；http 执行器解密后用 env 优先规则取值） */
    execSignSecret?: Uint8Array | null;
  };
  attempt: number;
  signal: AbortSignal;
  /** 本次执行的 runId（execution.id），供 X-Execution-Id 对账头 */
  runId?: string;
  /**
   * 回调触发类型（sqleditor 约定）：1-定时 2-手动 3-失败后重新执行。
   * 由 service 按 trigger/attempt 映射后传入，执行器只负责透传。
   */
  triggerType?: number;
  /**
   * 进度心跳：执行器取得进展（如流式响应收到 chunk）时调用，
   * 重置 withTimeout 的空闲计时器——流式长请求不被总时长误杀。
   */
  onProgress?: () => void;
}

export type TaskExecutor = (input: TaskExecutorInput) => Promise<{ result?: unknown }>;

const executors = new Map<string, TaskExecutor>();

export function registerExecutor(type: string, executor: TaskExecutor): void {
  executors.set(type, executor);
}

export function getExecutor(type: string): TaskExecutor {
  const executor = executors.get(type);
  if (!executor) {
    throw new Error(`no executor registered for taskType=${type}`);
  }
  return executor;
}
