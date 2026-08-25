import { registerExecutor } from "./registry";
import { httpExecutor } from "./executors/http";
import { noopExecutor } from "./executors/noop";

/** 注册默认执行器（worker 启动 / 测试 setup 调用）。 */
export function registerDefaultExecutors(): void {
  registerExecutor("http", httpExecutor);
  registerExecutor("noop", noopExecutor);
}