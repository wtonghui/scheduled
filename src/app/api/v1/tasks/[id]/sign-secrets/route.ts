import { fail, ok } from "@/lib/api-envelope";
import { requireAuth } from "@/modules/auth/middleware";
import * as taskService from "@/modules/task/service";
import type { NextRequest } from "next/server";

/**
 * 密钥交接读取（供接收方验签）：
 * GET /api/v1/tasks/:id/sign-secrets → { taskId, webhookSecret, execSignSecret }（明文）。
 * 仅 api-token 有效性 + 租户隔离（跨租户/不存在 → 404，不泄露存在性）；无 webhookUrl 的任务对应项为 null。
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const GET = requireAuth()(async (_req: NextRequest, auth, ctx: Ctx): Promise<Response> => {
  try {
    const { id } = await ctx.params;
    const secrets = await taskService.getSignSecrets(auth.tenantId, id);
    return ok(secrets);
  } catch (error) {
    return fail(error);
  }
});
