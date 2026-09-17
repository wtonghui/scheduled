import { fail, noContent, ok } from "@/lib/api-envelope";
import { optionalAuth, requireAuth } from "@/modules/auth/middleware";
import * as taskService from "@/modules/task/service";
import type { NextRequest } from "next/server";

/**
 * 单任务资源（contracts/api.md §3-5）。
 * GET    /api/v1/tasks/:id → 详情（匿名跨租户只读；带 token 则跨租户 404）
 * PATCH  /api/v1/tasks/:id → 更新（须 token；带 version，并发冲突 409）
 * DELETE /api/v1/tasks/:id → 204 硬删除（须 token）
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const GET = optionalAuth(async (_req: NextRequest, auth, ctx: Ctx): Promise<Response> => {
  try {
    const { id } = await ctx.params;
    // 跨租户只读详情：带 token 则据其租户标注 writable（本租户=可写）。
    const task = await taskService.getAny(id, auth?.tenantId ?? null);
    return ok(task);
  } catch (error) {
    return fail(error);
  }
});

export const PATCH = requireAuth({ scopes: ["tasks:write"] })(
  async (req: NextRequest, auth, ctx: Ctx): Promise<Response> => {
    try {
      const { id } = await ctx.params;
      const body = await req.json();
      const systemUserIdHeader = req.headers.get("x-system-user-id") as string | null;
      const updateBody = systemUserIdHeader ? { ...body, systemUserId: systemUserIdHeader } : body;
      const task = await taskService.update(auth.tenantId, id, updateBody, {
        actorTokenId: auth.tokenId,
      });
      return ok(task);
    } catch (error) {
      return fail(error);
    }
  },
);

export const DELETE = requireAuth({ scopes: ["tasks:write"] })(
  async (_req: NextRequest, auth, ctx: Ctx): Promise<Response> => {
    try {
      const { id } = await ctx.params;
      await taskService.remove(auth.tenantId, id);
      return noContent();
    } catch (error) {
      return fail(error);
    }
  },
);
