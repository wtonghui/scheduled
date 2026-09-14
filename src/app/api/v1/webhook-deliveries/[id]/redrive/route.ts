import { fail, ok } from "@/lib/api-envelope";
import { logger } from "@/lib/logger";
import { requireAuth } from "@/modules/auth/middleware";
import { redriveWebhook } from "@/modules/notification/repository";
import type { NextRequest } from "next/server";

/**
 * Webhook 死信重投（P1-2）。
 * POST /api/v1/webhook-deliveries/:id/redrive → dead 行回到 pending（attempts 归零，立刻可领）。
 * 仅 dead 可重投（其余 409），跨租户一律 404。
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const POST = requireAuth({ scopes: ["tasks:write"] })(
  async (req: NextRequest, auth, ctx: Ctx): Promise<Response> => {
    try {
      const { id } = await ctx.params;
      const row = await redriveWebhook(id, auth.tenantId, auth.tokenId);
      return ok(row);
    } catch (error) {
      logger.error({ error }, "POST /webhook-deliveries/[id]/redrive failed");
      return fail(error);
    }
  },
);
