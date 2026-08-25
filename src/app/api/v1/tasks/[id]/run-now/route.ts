import type { NextRequest } from "next/server";
import { requireAuth } from "@/modules/auth/middleware";
import * as taskService from "@/modules/task/service";
import { ok, fail } from "@/lib/api-envelope";

/**
 * 立即运行（contracts/api.md §6）：
 * POST /api/v1/tasks/:id/run-now → 202 { executionId, status }
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const POST = requireAuth({ scopes: ["tasks:write"] })(
  async (_req: NextRequest, auth, ctx: Ctx): Promise<Response> => {
    try {
      const { id } = await ctx.params;
      const execution = await taskService.runTaskNow(auth.tenantId, id);
      return ok({ executionId: execution.id, status: execution.status }, undefined, 202);
    } catch (error) {
      return fail(error);
    }
  },
);