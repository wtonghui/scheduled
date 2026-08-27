import { fail, ok, okCreated } from "@/lib/api-envelope";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { requireAuth } from "@/modules/auth/middleware";
import { createApiToken, listTokens } from "@/modules/auth/service";
import type { NextRequest } from "next/server";

/**
 * Token 管理（contracts/api.md T1/T2）。
 * GET  /api/v1/tokens         → 需 tokens:manage scope：本租户 token 列表（不含明文/哈希）
 * POST /api/v1/tokens         → 免鉴权签发（单默认租户临时约定；明文仅此一次，多租户落地时恢复鉴权）
 */

export const runtime = "nodejs";

export const GET = requireAuth({ scopes: ["tokens:manage"] })(
  async (_req: NextRequest, auth): Promise<Response> => {
    try {
      const tokens = await listTokens(auth.tenantId);
      return ok(tokens);
    } catch (error) {
      return fail(error);
    }
  },
);

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      name?: string;
      scopes?: string[];
      expiresAt?: string | null;
    };
    // 单默认租户阶段免鉴权：token 归 default 租户。
    // 多租户落地时恢复 requireAuth({ scopes: ["tokens:manage"] }) 并从 auth 取 tenantId。
    const tenant = await prisma.tenant.findFirst();
    if (!tenant) {
      throw new AppError(409, "BOOTSTRAP_REQUIRED", "no default tenant yet: run seed first");
    }
    const created = await createApiToken({
      name: body.name,
      scopes: body.scopes,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      tenantId: tenant.id,
      createdBy: "anonymous",
    });
    return okCreated(created);
  } catch (error) {
    return fail(error);
  }
}
