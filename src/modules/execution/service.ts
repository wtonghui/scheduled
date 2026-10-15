import { withTimeout } from "@/lib/concurrency";
import { prisma } from "@/lib/db";
import { toBeijingIso } from "@/lib/datetime";
import { HttpError, TimeoutError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  deadLetterTotal,
  taskAttemptsTotal,
  taskDurationMs,
  taskInFlight,
  taskRunsTotal,
} from "@/lib/metrics";
import { classifyError, computeRetryDelayMs } from "@/lib/retry";
import {
  type NotifyContext,
  type PreparedOutbox,
  type RunSummary,
  buildNotifySnapshot,
  notificationExpectation,
  prepareNotificationOutbox,
  writePreparedOutbox,
} from "@/modules/notification/service";
import { buildWebhookPayload } from "@/modules/webhook/service";
import type { Prisma } from "@prisma/client";
import { type TaskExecutorInput, getExecutor } from "./registry";

/**
 * 执行生命周期（data-model.md 状态转移、FR-006/FR-007）。
 * 每次重试 = 新执行行（attempt 递增）；幂等键含 attempt 防重复领取。
 * 成功 → succeeded；可重试耗尽 → dead；永久错误 → failed。
 * 终态在**同一事务**写入 email_log / webhook_delivery outbox（FR-008/FR-016）。
 */

export interface RunTaskDefinition {
  id: string;
  taskType: "http" | "noop";
  payload: Record<string, unknown>;
  payloadSecrets: Uint8Array | null;
  timeoutMs: number;
  maxAttempts: number;
  /** 同次调度内重试等待基线（毫秒）；缺省/null=默认退避（1s 起，实际 0~min(封顶,基线×2ⁿ)，封顶=max(30s,基线)） */
  retryDelayMs?: number | null;
  tenantId: string;
  taskName: string;
  recipients: string[];
  notifyOn: string[];
  webhookUrl: string | null;
  webhookSecret: Uint8Array | null;
  systemUserId?: string | null;
  /** 任务执行请求签名密钥（加密字节；Phase 2 对方按任务验签后启用，当前取值恒走 env） */
  execSignSecret?: Uint8Array | null;
  /** 邮件标题模板；null=默认标题 */
  emailSubjectTemplate?: string | null;
  /** 邮件正文模板（HTML）；null=默认 React Email */
  emailBodyTemplate?: string | null;
  /** 失败专用标题模板；null=回退成功模板 */
  emailSubjectTemplateFailed?: string | null;
  /** 失败专用正文模板；null=回退成功模板 */
  emailBodyTemplateFailed?: string | null;
  /** 附件 URL 模板；null=无附件 */
  emailAttachmentUrlTemplate?: string | null;
}

export interface RunOutcome {
  executionId: string;
  status: "succeeded" | "failed" | "timeout" | "dead";
}

async function createExecution(
  taskId: string,
  idempotencyKey: string,
  scheduledAt: Date,
  attempt: number,
  trigger: "scheduled" | "manual",
  systemUserId?: string | null,
) {
  try {
    const created = await prisma.taskExecution.create({
      data: {
        taskId,
        idempotencyKey,
        scheduledAt,
        attempt,
        trigger,
        status: "pending",
        ...(systemUserId ? { systemUserId } : {}),
      },
    });
    // 配额计数（retention 设计）：attempt=1 的 scheduled 创建即占配额（manual 永不占；
    // queued 走 claim 排队分支另计）。只在真实创建时 +1，P2002 复用不加。
    // 单语句原子增，多 pod 不丢数；归档搬运动它（计数含已归档，配额永不复活）。
    if (attempt === 1 && trigger === "scheduled") {
      await prisma.task.update({
        where: { id: taskId },
        data: { consumedRuns: { increment: 1 } },
      });
    }
    return created;
  } catch (error) {
    // 并发重复领取 → 幂等复用既有行
    if ((error as { code?: string }).code === "P2002") {
      const existing = await prisma.taskExecution.findUnique({ where: { idempotencyKey } });
      if (existing) {
        return existing;
      }
    }
    throw error;
  }
}

/**
 * 业务成败判定（自动两段式，无需任务配置）：
 * HTTP 非 2xx 由执行器按原逻辑判失败；HTTP 2xx 且包体含 `code` 时，
 * 仅数字 200 算成功，其余（0、字符串 "200" 等）全算失败，`msg` 作失败原因。
 * 包体无 `code`（如 {ok:true}、纯文本）→ 成功，老行为不变。
 * 命中失败返回可展示的原因串，调用方按永久错（HttpError 422，不重试）处理。
 */
export function businessFailureMessage(executorResult: unknown): string | null {
  // 执行器返回值形如 { status, redirects, attempt, data }，data 即包体
  const body = (executorResult as { data?: unknown } | null | undefined)?.data;
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (!("code" in record)) {
    return null;
  }
  if (record.code === 200) {
    return null;
  }
  const msg = record.msg;
  if (typeof msg === "string" && msg.trim()) {
    return msg;
  }
  return `business code ${String(record.code)}`;
}

function serializeError(error: unknown): Prisma.InputJsonValue {
  const err = error as { message?: string; status?: number; code?: string } | null;
  return {
    class:
      error instanceof TimeoutError ? "timeout" : error instanceof HttpError ? "http" : "error",
    message: err?.message ?? String(error),
    ...(typeof err?.status === "number" ? { status: err.status } : {}),
    ...(typeof err?.code === "string" ? { code: err.code } : {}),
  };
}

interface FinalizeFields {
  status: "succeeded" | "failed" | "timeout" | "dead";
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  error?: Prisma.InputJsonValue;
}

/** 纯字符串 HTML 转义（降级通知用，不依赖任何渲染引擎）。 */
function escapeDegradedHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 降级通知（永不抛）：正常渲染链（React Email / 模板引擎）抛到外层时用它兜底，
 * 只做纯字符串拼接，保证“该发就有行”——“终态无 outbox”在代码上不可能发生。
 * 附件固定 null（只保到达，中继不下载）。
 */
export function buildDegradedOutbox(
  notifyCtx: NotifyContext,
  summary: RunSummary,
  fields: FinalizeFields,
  errorMessage: string | null,
  emailExpected: boolean,
  webhookExpected: boolean,
): PreparedOutbox {
  const out: PreparedOutbox = {};
  if (emailExpected) {
    const ok = fields.status === "succeeded";
    const subject = `${ok ? "✅" : "❌"} [${String(summary.taskName)}] 执行${ok ? "成功" : "失败"}（降级通知）`;
    const lines = [
      `Task: ${String(summary.taskId)} (${String(notifyCtx.taskName)})`,
      `Run: ${String(summary.executionId)}`,
      `Status: ${String(fields.status)}`,
      `Scheduled: ${summary.scheduledAt.toISOString()}`,
      `Finished: ${fields.finishedAt.toISOString()}`,
      `Duration: ${String(fields.durationMs)}ms`,
      ...(errorMessage ? [`Error: ${errorMessage}`] : []),
      "说明：完整模板渲染失败，此为降级通知，详情请查执行记录。",
    ];
    const text = lines.join("\n");
    const html = `<div>${lines.map((l) => escapeDegradedHtml(l)).join("<br>")}</div>`;
    out.email = {
      toAddress: JSON.stringify(notifyCtx.recipients),
      subject,
      html,
      text,
      attachmentUrl: null,
    };
  }
  if (webhookExpected && notifyCtx.webhookUrl) {
    let payload: Prisma.InputJsonValue;
    try {
      payload = buildWebhookPayload({
        runId: summary.executionId,
        taskId: summary.taskId,
        taskName: summary.taskName,
        status: summary.status,
        scheduledAt: toBeijingIso(summary.scheduledAt),
        startedAt: summary.startedAt ? toBeijingIso(summary.startedAt) : null,
        finishedAt: toBeijingIso(fields.finishedAt),
        durationMs: fields.durationMs,
        nextRunAt: notifyCtx.nextRunAt ? toBeijingIso(notifyCtx.nextRunAt) : null,
        disabledReason: notifyCtx.disabledReason ?? null,
        ...(errorMessage ? { error: { message: errorMessage } } : {}),
      }) as Prisma.InputJsonValue;
    } catch {
      // 时间格式化极端失败时的最后底线：裸字符串载荷，总能 JSON 化
      payload = {
        runId: String(summary.executionId),
        taskId: String(summary.taskId),
        taskName: String(summary.taskName),
        status: String(summary.status),
        degraded: true,
        ...(errorMessage ? { error: { message: String(errorMessage) } } : {}),
      } as Prisma.InputJsonValue;
    }
    out.webhook = { url: notifyCtx.webhookUrl, payload };
  }
  return out;
}

/** 终态更新 + 通知 outbox 同一事务（run_id 唯一幂等）。渲染在事务外，DB 瞬时冲突退避重试。 */
async function finalizeExecution(
  executionId: string,
  fields: FinalizeFields,
  task: RunTaskDefinition,
  scheduledAt: Date,
  errorMessage: string | null,
  executorResult?: unknown,
): Promise<void> {
  // 防御：缺省通知上下文（测试/手工构造定义时）→ 不通知、不报错
  const notifyCtx: NotifyContext = {
    tenantId: task.tenantId ?? "",
    taskId: task.id,
    taskName: task.taskName ?? task.id,
    recipients: task.recipients ?? [],
    notifyOn: task.notifyOn ?? [],
    webhookUrl: task.webhookUrl ?? null,
    webhookSecretBytes: task.webhookSecret ?? null,
    systemUserId: task.systemUserId ?? null,
    emailSubjectTemplate: task.emailSubjectTemplate ?? null,
    emailBodyTemplate: task.emailBodyTemplate ?? null,
    emailSubjectTemplateFailed: task.emailSubjectTemplateFailed ?? null,
    emailBodyTemplateFailed: task.emailBodyTemplateFailed ?? null,
    emailAttachmentUrlTemplate: task.emailAttachmentUrlTemplate ?? null,
  };
  const summary: RunSummary = {
    executionId,
    taskId: task.id,
    taskName: task.taskName,
    status: fields.status === "succeeded" ? "succeeded" : "failed",
    scheduledAt,
    startedAt: fields.startedAt,
    finishedAt: fields.finishedAt,
    durationMs: fields.durationMs,
    errorMessage: errorMessage ?? null,
    result: executorResult,
  };
  // 终态快照：领取时 next_run_at 已推进、停用原因已写入，读行即得下次触发与停用状态；
  // 读失败降级 null（只影响 webhook payload 两字段，绝不阻塞终态落库）
  const taskState = await prisma.task
    .findUnique({ where: { id: task.id }, select: { nextRunAt: true, disabledReason: true } })
    .catch(() => null);
  notifyCtx.nextRunAt = taskState?.nextRunAt ?? null;
  notifyCtx.disabledReason = taskState?.disabledReason ?? null;
  // 终态意图冻结：按当时的 ctx + 结果判定这次该不该发（与 prepare 门控同口径），
  // 与任务事后改配置解耦，期望列同时当审计。
  const statusKey = fields.status === "succeeded" ? "succeeded" : "failed";
  const { emailExpected, webhookExpected } = notificationExpectation(
    notifyCtx,
    statusKey,
    executorResult,
  );
  const notifySnapshot = buildNotifySnapshot(notifyCtx, summary) as unknown as Prisma.InputJsonValue;
  // 事务外预渲染：CPU 活不持 DB 锁；正常渲染抛到外层时用纯字符串降级兜底
  // （永不抛），保证 emailExpected/webhookExpected=true 就一定有行——
  // “终态无 outbox”在代码上不可能发生（渲染失败走上面降级，DB 失败则事务回滚终态也不落）。
  let prepared: PreparedOutbox | null = null;
  try {
    prepared = await prepareNotificationOutbox(notifyCtx, summary);
  } catch (error) {
    logger.error(
      { err: (error as Error).message, execution_id: executionId },
      "notification render failed, using degraded fallback",
    );
    prepared = buildDegradedOutbox(
      notifyCtx,
      summary,
      fields,
      errorMessage,
      emailExpected,
      webhookExpected,
    );
  }
  // 瞬时 DB 冲突（P2034/P2028）退避重试 3 次，防抖动丢终态
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const preparedSnapshot = prepared;
      await prisma.$transaction(async (tx) => {
        await tx.taskExecution.update({
          where: { id: executionId },
          data: {
            status: fields.status,
            startedAt: fields.startedAt,
            finishedAt: fields.finishedAt,
            durationMs: fields.durationMs,
            ...(fields.error !== undefined ? { error: fields.error } : {}),
            emailExpected,
            webhookExpected,
            notifySnapshot,
          },
        });
        try {
          await writePreparedOutbox(notifyCtx, summary, preparedSnapshot, tx);
        } catch (error) {
          if ((error as { code?: string }).code === "P2002") {
            return;
          }
          throw error;
        }
      });
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      lastError = error;
      if ((code === "P2034" || code === "P2028") && attempt < 3) {
        await new Promise((r) => setTimeout(r, computeRetryDelayMs(200, attempt - 1)));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export async function runTaskWithScheduledAt(
  task: RunTaskDefinition,
  scheduledAt: Date,
  trigger: "scheduled" | "manual",
  opts: { executionId?: string; externalSignal?: AbortSignal } = {},
): Promise<RunOutcome> {
  const executor = getExecutor(task.taskType);
  const input: TaskExecutorInput = {
    task: {
      id: task.id,
      taskType: task.taskType,
      payload: task.payload,
      payloadSecrets: task.payloadSecrets,
      timeoutMs: task.timeoutMs,
      execSignSecret: task.execSignSecret ?? null,
    },
    attempt: 1,
    signal: new AbortController().signal,
  };

  for (let attempt = 1; attempt <= task.maxAttempts; attempt += 1) {
    const key = `${task.id}:${scheduledAt.toISOString()}:a${attempt}`;

    const execution =
      opts.executionId && attempt === 1
        ? await prisma.taskExecution.findUnique({ where: { id: opts.executionId } })
        : await createExecution(task.id, key, scheduledAt, attempt, trigger, task.systemUserId);

    if (!execution) {
      throw new Error(`manual execution ${opts.executionId} not found`);
    }
    if (
      execution.status === "succeeded" ||
      execution.status === "failed" ||
      execution.status === "dead" ||
      execution.status === "timeout"
    ) {
      // 幂等命中：复用既有终态（并发重复领取场景）
      return { executionId: execution.id, status: execution.status } as RunOutcome;
    }

    const startedAt = new Date();
    taskInFlight.inc();
    await prisma.taskExecution.update({ where: { id: execution.id }, data: { status: "running" } });

    try {
      // onProgress 由执行器在流式取得进展时调用 → withTimeout 重置空闲计时器（长流续命）；
      // externalSignal 为进程级中止（如 shutdown 超时强杀）
      // 回调触发类型（sqleditor 约定）：重试 attempt（失败后重新执行）→ 3，
      // 否则 manual → 2，scheduled → 1
      const triggerType = attempt > 1 ? 3 : trigger === "manual" ? 2 : 1;
      const execResult = await withTimeout(
        (signal, onProgress) =>
          executor({ ...input, attempt, signal, onProgress, runId: execution.id, triggerType }),
        task.timeoutMs,
        opts.externalSignal,
      );
      // 包体业务失败 → 按永久错处理（422 不重试，直接 failed + 失败通知；
      // message 即上游 msg 原文，进 errorMessage 做失败原因展示）
      const businessFailure = businessFailureMessage(execResult?.result);
      if (businessFailure) {
        // 结果挂在 error 上带进 catch：失败邮件仍需内层 data（站内链接/执行时间）
        const err = new HttpError(422, businessFailure);
        (err as { executorResult?: unknown }).executorResult = execResult?.result;
        throw err;
      }
      taskAttemptsTotal.inc({ status: "succeeded" });
      taskRunsTotal.inc({ status: "succeeded" });
      await finalizeExecution(
        execution.id,
        {
          status: "succeeded",
          startedAt,
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt.getTime(),
        },
        task,
        scheduledAt,
        null,
        execResult?.result,
      );
      logger.info(
        {
          task_id: task.id,
          execution_id: execution.id,
          attempt,
          status: "succeeded",
          duration_ms: Date.now() - startedAt.getTime(),
        },
        "task run finished",
      );
      return { executionId: execution.id, status: "succeeded" };
    } catch (error) {
      const finishedAt = new Date();
      const terminal = terminalStatusOf(error);
      const errorJson = serializeError(error);

      const verdict = classifyError(error);
      if (verdict === "permanent") {
        taskAttemptsTotal.inc({ status: "failed" });
        taskRunsTotal.inc({ status: "failed" });
        await finalizeExecution(
          execution.id,
          {
            status: terminal,
            startedAt,
            finishedAt,
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            error: errorJson,
          },
          task,
          scheduledAt,
          (error as Error).message,
          (error as { executorResult?: unknown }).executorResult,
        );
        logger.warn(
          { task_id: task.id, attempt, err: (error as Error).message },
          "task failed permanently",
        );
        return { executionId: execution.id, status: "failed" };
      }

      if (attempt < task.maxAttempts) {
        // 封顶跟随基线：默认 base=1000 时 cap 仍 30000（老行为不变）；
        // 自定义基线（如 300000）不再被 30s 钳住。抖动（uniform 随机）保留。
        const retryBaseMs = task.retryDelayMs ?? 1000;
        const delayMs = computeRetryDelayMs(retryBaseMs, attempt - 1);
        logger.info({ task_id: task.id, attempt, delayMs }, "task attempt failed, will retry");
        taskAttemptsTotal.inc({ status: terminal });
        await prisma.taskExecution.update({
          where: { id: execution.id },
          data: {
            status: terminal,
            startedAt,
            finishedAt,
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            error: errorJson,
          },
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      // 重试耗尽 → 死信（终态事务写 outbox）
      taskAttemptsTotal.inc({ status: terminal });
      taskRunsTotal.inc({ status: "dead" });
      deadLetterTotal.inc({ task_id: task.id });
      await finalizeExecution(
        execution.id,
        {
          status: "dead",
          startedAt,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          error: errorJson,
        },
        task,
        scheduledAt,
        (error as Error).message,
      );
      logger.error(
        {
          task_id: task.id,
          attempt,
          max_attempts: task.maxAttempts,
          err: (error as Error).message,
        },
        "task dead-lettered after max attempts",
      );
      return { executionId: execution.id, status: "dead" };
    } finally {
      taskInFlight.dec();
      taskDurationMs.observe(Date.now() - startedAt.getTime());
    }
  }

  throw new Error("unreachable: runTaskWithScheduledAt loop");
}

function terminalStatusOf(error: unknown): "failed" | "timeout" {
  if (error instanceof TimeoutError) {
    return "timeout";
  }
  return "failed";
}
