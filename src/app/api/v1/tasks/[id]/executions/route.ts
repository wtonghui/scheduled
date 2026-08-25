import type { NextRequest } from "next/server";
import { optionalAuth } from "@/modules/auth/middleware";
import { listByTaskAny } from "@/modules/execution/repository";
import { ok, fail } from "@/lib/api-envelope";

/**
 * 单任务执行历史（contracts/api.md §7）：带分页。
 * GET /api/v1/tasks/:id/executions?page=&pageSize=&status=
 *      全量只读视图：匿名/登录均按 taskId 跨租户只读（受信网络）。
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const GET = optionalAuth(
  async (req: NextRequest, _auth, ctx: Ctx): Promise<Response> => {
    try {
      const { id } = await ctx.params;
      const { searchParams } = new URL(req.url);
      const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
      const pageSize = Math.min(
        100,
        Math.max(1, Number(searchParams.get("pageSize") ?? "20") || 20),
      );

      const { rows, total } = await listByTaskAny(id, page, pageSize);
      return ok(rows, { page, pageSize, total });
    } catch (error) {
      return fail(error);
    }
  },
);