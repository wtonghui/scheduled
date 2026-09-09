import type { NextRequest } from "next/server";
import { requireAuth } from "@/modules/auth/middleware";
import { listEmailLog } from "@/modules/notification/repository";
import { ok, fail } from "@/lib/api-envelope";

/**
 * 邮件日志（contracts/api.md §9）：?runId=&status=&page=&pageSize=。
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
      const runId = searchParams.get("runId") ?? undefined;
      const status = searchParams.get("status") ?? undefined;
      const systemUserId = searchParams.get("system_user_id") ?? undefined;
      const { rows, total } = await listEmailLog(auth.tenantId, page, pageSize, runId, status, systemUserId);
      return ok(rows, { page, pageSize, total });
    } catch (error) {
      return fail(error);
    }
  },
);