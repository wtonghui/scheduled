import type { TaskExecutor } from "../registry";

/** noop 执行器：自测用，立即成功。 */
export const noopExecutor: TaskExecutor = async () => {
  return { result: { kind: "noop" } };
};