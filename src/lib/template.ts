import { logger } from "./logger";

/**
 * 简易模板引擎：`{path.to.field}` → 从 context 按点号路径取值。
 * 找到 → 替换为值（toString）；没找到 → 保留原始 `{xxx}`（自文档化，收件人/开发者都能看到哪个没匹配）。
 * 不支持条件/循环——要复杂逻辑走 webhook 自渲染。
 *
 * 无匹配时记 warn 日志，让任务创建者能从日志主动发现（不等收件人投诉）。
 */
export function renderTemplate(
  template: string,
  context: Record<string, unknown>,
  logTag?: { taskId?: string; runId?: string },
): string {
  return template.replace(/\{([^}]+)\}/g, (match, rawPath: string) => {
    const path = rawPath.trim();
    const value = resolvePath(path, context);
    if (value === undefined) {
      if (logTag) {
        logger.warn({ ...logTag, placeholder: path }, "template placeholder not found in response");
      }
      return match; // 保留原始 {xxx}
    }
    if (value === null) {
      return "";
    }
    if (typeof value === "object") {
      return JSON.stringify(value);
    }
    return String(value);
  });
}

/** 按点号路径逐级取值；任一层 undefined 即整体 undefined。 */
function resolvePath(path: string, context: Record<string, unknown>): unknown {
  const parts = path.split(".");
  let current: unknown = context;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
