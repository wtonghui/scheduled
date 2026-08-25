import type { NextRequest } from "next/server";
import { requireAuth } from "@/modules/auth/middleware";
import { listWebhookDeliveries } from "@/modules/notification/repository";
import { ok, fail } from "@/lib/api-envelope";

/**
 * 单任务 Webhook 投递历史（contracts/api.md W1）。
 * GET /api/v1/tasks/:id/webhook-deliveries?page=&pageSize=
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
      const { rows, total } = await listWebhookDeliveries(auth.tenantId, id, page, pageSize);
      return ok(rows, { page, pageSize, total });
    } catch (error) {
      return fail(error);
    }
  },
);