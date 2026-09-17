import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/db";
import * as taskService from "../../src/modules/task/service";
import { claimDueItems } from "../../worker/scheduler";
import { cleanupTenant, createTestTenant, createTestToken } from "./helpers";

/**
 * 停用原因端到端（写时定夺）：
 * manual 手动 / run_once_done 单次跑完 / ends_at 到截止 / max_runs 到次数。
 * 重启用清空三字段。
 */

describe("task stop reason (integration)", () => {
  let tenantId: string;
  let ownerTokenId: string;

  beforeAll(async () => {
    const t = await createTestTenant("stop-reason");
    tenantId = t.id;
    ownerTokenId = (await createTestToken(tenantId, ["tasks:read", "tasks:write"], "owner")).id;
  });

  afterAll(async () => {
    await cleanupTenant(tenantId);
  });

  it("manual disable stamps manual + actor, re-enable clears", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "manual-stop",
      cron: "*/5 * * * *",
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    expect(created.disabledReason).toBeNull();

    const stopped = await taskService.update(
      tenantId,
      created.id,
      { enabled: false, version: created.version },
      { actorTokenId: ownerTokenId },
    );
    expect(stopped.enabled).toBe(false);
    expect(stopped.disabledReason).toBe("manual");
    expect(stopped.disabledBy).toBe(ownerTokenId);
    expect(stopped.disabledAt).toBeInstanceOf(Date);

    const row = await prisma.task.findUnique({ where: { id: created.id } });
    expect(row?.disabledReason).toBe("manual");

    const reenabled = await taskService.update(tenantId, created.id, {
      enabled: true,
      version: stopped.version,
    });
    expect(reenabled.enabled).toBe(true);
    expect(reenabled.disabledReason).toBeNull();
    expect(reenabled.disabledAt).toBeNull();
    expect(reenabled.disabledBy).toBeNull();
  });

  it("run-once claim stamps run_once_done", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "once-stop-reason",
      runAt: new Date(Date.now() + 1_200).toISOString(),
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    // 轮询领取直到停用：并行套件下别文件的 claim 也可能先领走，
    // 但停用原因与谁领无关（写时定夺），最终态断言依然成立
    let row = await prisma.task.findUnique({ where: { id: created.id } });
    for (let i = 0; i < 10 && row?.enabled; i += 1) {
      await claimDueItems("stop-reason-worker", 30, 10);
      row = await prisma.task.findUnique({ where: { id: created.id } });
      if (row?.enabled) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    expect(row?.enabled).toBe(false);
    expect(row?.disabledReason).toBe("run_once_done");
    expect(row?.disabledAt).toBeInstanceOf(Date);
  }, 15_000);

  it("exhausted maxRuns stamps max_runs", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "maxruns-stop-reason",
      cron: "*/5 * * * *",
      maxRuns: 2,
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    // 配额打满 + 到期 → 下轮领取直接停用（不执行）
    await prisma.task.update({
      where: { id: created.id },
      data: { consumedRuns: 2, nextRunAt: new Date(Date.now() - 1_000) },
    });
    await claimDueItems("stop-reason-worker", 30, 10);
    const row = await prisma.task.findUnique({ where: { id: created.id } });
    expect(row?.enabled).toBe(false);
    expect(row?.nextRunAt).toBeNull();
    expect(row?.disabledReason).toBe("max_runs");
  }, 15_000);

  it("past endsAt stamps ends_at", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "endsat-stop-reason",
      cron: "*/5 * * * *",
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    // 截止调到过去 + tick 超窗 → 下轮领取停用
    const past = new Date(Date.now() - 60_000);
    await prisma.task.update({
      where: { id: created.id },
      data: { endsAt: past, nextRunAt: new Date(Date.now() - 1_000) },
    });
    await claimDueItems("stop-reason-worker", 30, 10);
    const row = await prisma.task.findUnique({ where: { id: created.id } });
    expect(row?.enabled).toBe(false);
    expect(row?.disabledReason).toBe("ends_at");
  }, 15_000);

  it("claim stamps no_future_schedule for expired cron", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "nofuture-stop-reason",
      cron: "*/5 * * * *",
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    // cron 改成已过年份（无未来运行）+ tick 过期 → 下轮领取停用
    await prisma.task.update({
      where: { id: created.id },
      data: { cron: "0 0 0 1 1 ? 2000", nextRunAt: new Date(Date.now() - 1_000) },
    });
    await claimDueItems("stop-reason-worker", 30, 10);
    const row = await prisma.task.findUnique({ where: { id: created.id } });
    expect(row?.enabled).toBe(false);
    expect(row?.disabledReason).toBe("no_future_schedule");
  }, 15_000);
});

describe("quota reset + re-enable fail-fast (integration)", () => {
  let tenantId: string;
  let ownerTokenId: string;

  beforeAll(async () => {
    const t = await createTestTenant("stop-revive");
    tenantId = t.id;
    ownerTokenId = (await createTestToken(tenantId, ["tasks:read", "tasks:write"], "owner")).id;
  });

  afterAll(async () => {
    await cleanupTenant(tenantId);
  });

  /** 配额用尽的停用任务（直接摆状态， deterministic，不依赖领取时序）。 */
  async function exhaustedTask(name: string) {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name,
      cron: "*/5 * * * *",
      maxRuns: 2,
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    await prisma.task.update({
      where: { id: created.id },
      data: {
        consumedRuns: 2,
        enabled: false,
        nextRunAt: null,
        disabledReason: "max_runs",
        disabledAt: new Date(),
        disabledBy: "stop-reason-worker",
      },
    });
    return created;
  }

  it("revive: reset + enable in one PATCH is atomic", async () => {
    const created = await exhaustedTask("revive-once");
    const revived = await taskService.update(
      tenantId,
      created.id,
      { resetConsumedRuns: true, enabled: true, version: created.version },
      { actorTokenId: ownerTokenId },
    );
    expect(revived.enabled).toBe(true);
    expect(revived.consumedRuns).toBe(0);
    expect(revived.disabledReason).toBeNull();
    expect(revived.nextRunAt).toBeInstanceOf(Date);
    const row = await prisma.task.findUnique({ where: { id: created.id } });
    expect(row?.consumedRuns).toBe(0);
  });

  it("reset on an enabled task → 400", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "reset-enabled-400",
      cron: "*/5 * * * *",
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    await expect(
      taskService.update(tenantId, created.id, {
        resetConsumedRuns: true,
        version: created.version,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("resetConsumedRuns: false → 400 (must omit, not send false)", async () => {
    const created = await exhaustedTask("reset-false-400");
    await expect(
      taskService.update(tenantId, created.id, {
        resetConsumedRuns: false,
        version: created.version,
      } as unknown as { version: number }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("re-enable with exhausted quota and no reset → 400", async () => {
    const created = await exhaustedTask("enable-exhausted-400");
    await expect(
      taskService.update(tenantId, created.id, { enabled: true, version: created.version }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("re-enable past endsAt → 400", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "enable-endsat-400",
      cron: "*/5 * * * *",
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    const stoppedView = await taskService.update(
      tenantId,
      created.id,
      { enabled: false, version: created.version },
      { actorTokenId: ownerTokenId },
    );
    // 截止调到过去 → 重启用必须 fail-fast（直连改 endsAt 不走 version，本轮 version 仍是停用后的）
    await prisma.task.update({
      where: { id: created.id },
      data: { endsAt: new Date(Date.now() - 60_000) },
    });
    await expect(
      taskService.update(tenantId, created.id, {
        enabled: true,
        version: stoppedView.version,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("re-enable expired cron → 400 (no future run)", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "enable-nofuture-400",
      cron: "*/5 * * * *",
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    const stopped = await taskService.update(tenantId, created.id, {
      enabled: false,
      version: created.version,
    });
    await prisma.task.update({
      where: { id: created.id },
      data: { cron: "0 0 0 1 1 ? 2000" },
    });
    await expect(
      taskService.update(tenantId, created.id, { enabled: true, version: stopped.version }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("concurrent revive with same version: exactly one wins", async () => {
    const created = await exhaustedTask("revive-race");
    const results = await Promise.allSettled([
      taskService.update(
        tenantId,
        created.id,
        { resetConsumedRuns: true, enabled: true, version: created.version },
        { actorTokenId: ownerTokenId },
      ),
      taskService.update(
        tenantId,
        created.id,
        { resetConsumedRuns: true, enabled: true, version: created.version },
        { actorTokenId: ownerTokenId },
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "VERSION_CONFLICT",
      status: 409,
    });
    const row = await prisma.task.findUnique({ where: { id: created.id } });
    expect(row?.enabled).toBe(true);
    expect(row?.consumedRuns).toBe(0);
  });
});
