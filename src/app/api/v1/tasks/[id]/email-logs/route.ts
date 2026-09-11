import { fail, ok } from "@/lib/api-envelope";
import { requireAuth } from "@/modules/auth/middleware";
import { listEmailLogByTask } from "@/modules/notification/repository";
import type { NextRequest } from "next/server";
import { logger } from "@/lib/logger";

/**
 * 单任务邮件投递历史。
 * GET /api/v1/tasks/:id/email-logs?status=&page=&pageSize=
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const GET = requireAuth({ scopes: ["tasks:read"] })(
  async (req: NextRequest, auth, ctx: Ctx): Promise<Response> => {
    try {
      const { id } = await ctx.params;
      const { searchParams } = new URL(req.url);
      const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
      const pageSize = Math.min(
        100,
        Math.max(1, Number(searchParams.get("pageSize") ?? "20") || 20),
      );
      const status = searchParams.get("status") ?? undefined;
      const systemUserId = searchParams.get("system_user_id") ?? undefined;
      const { rows, total } = await listEmailLogByTask(
        auth.tenantId,
        id,
        page,
        pageSize,
        status,
        systemUserId,
      );
      return ok(rows, { page, pageSize, total });
    } catch (error) {
      logger.error({ error }, "GET /tasks/[id]/email-logs failed");
      return fail(error);
    }
  },
);
