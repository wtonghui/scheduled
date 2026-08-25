import type { NextRequest } from "next/server";
import { requireAuth } from "@/modules/auth/middleware";
import { revokeToken } from "@/modules/auth/service";
import { noContent, fail } from "@/lib/api-envelope";

/**
 * 吊销 token（contracts/api.md T3）：需 tokens:manage。
 * DELETE /api/v1/tokens/:id → 204（不存在/已吊销也幂等返回 204）
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = requireAuth({ scopes: ["tokens:manage"] })(
  async (_req: NextRequest, auth, ctx: Ctx): Promise<Response> => {
    try {
      const { id } = await ctx.params;
      await revokeToken(auth.tenantId, id);
      return noContent();
    } catch (error) {
      return fail(error);
    }
  },
);