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