import { fail, ok } from "@/lib/api-envelope";
import { AppError } from "@/lib/errors";
import { requireAuth } from "@/modules/auth/middleware";
import { RotateSignSecretSchema } from "@/modules/task/dto";
import * as taskService from "@/modules/task/service";
import type { NextRequest } from "next/server";

/**
 * 密钥轮换：
 * POST /api/v1/tasks/:id/sign-secrets/rotate { key: "webhookSecret" | "execSignSecret" }
 * → { taskId, key, secret }（新密钥明文，仅本次返回）。
 * 仅 api-token 有效性 + 租户隔离；在途 outbox 快照行照旧（只影响之后入 outbox 的），
 * 轮换须跟接收方约同一分钟操作，否则窗口期内对方验签 401。
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const POST = requireAuth()(async (req: NextRequest, auth, ctx: Ctx): Promise<Response> => {
  try {
    const { id } = await ctx.params;
    const parsed = RotateSignSecretSchema.safeParse(await req.json());
    if (!parsed.success) {
      throw new AppError(
        400,
        "VALIDATION",
        "invalid rotate input",
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      );
    }
    const result = await taskService.rotateSignSecret(auth.tenantId, id, parsed.data.key);
    return ok(result);
  } catch (error) {
    return fail(error);
  }
});
