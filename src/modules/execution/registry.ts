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
  };
  attempt: number;
  signal: AbortSignal;
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
