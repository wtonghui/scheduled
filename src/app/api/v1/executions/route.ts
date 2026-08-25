import type { NextRequest } from "next/server";
import { requireAuth } from "@/modules/auth/middleware";
import { listAll } from "@/modules/execution/repository";
import { ok, fail } from "@/lib/api-envelope";

/**
 * 全局执行历史（contracts/api.md §8）：跨任务，可选 ?taskId=&status=。
 * GET /api/v1/executions?page=&pageSize=&taskId=&status=
 */

export const runtime = "nodejs";

export const GET = requireAuth({ scopes: ["tasks:read"] })(
  async (req: NextRequest, auth): Promise<Response> => {
    try {
      const { searchParams } = new URL(req.url);
      const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
      const pageSize = Math.min(
        100,
        Math.max(1, Number(searchParams.get("pageSize") ?? "20") || 20),
      );
      const taskId = searchParams.get("taskId") ?? undefined;
      const status = searchParams.get("status") ?? undefined;

      const { rows, total } = await listAll(auth.tenantId, page, pageSize, taskId, status);
      return ok(rows, { page, pageSize, total });
    } catch (error) {
      return fail(error);
    }
  },
);