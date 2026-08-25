import type { NextRequest } from "next/server";
import { requireAuth } from "@/modules/auth/middleware";
import { createApiToken, listTokens } from "@/modules/auth/service";
import { ok, okCreated, fail } from "@/lib/api-envelope";

/**
 * Token 管理（contracts/api.md T1/T2）：均需 tokens:manage scope。
 * POST /api/v1/tokens         → 201 { ...token 明文仅此一次 }
 * GET  /api/v1/tokens         → 本租户 token 列表（不含明文/哈希）
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

export const POST = requireAuth({ scopes: ["tokens:manage"] })(
  async (req: NextRequest, auth): Promise<Response> => {
    try {
      const body = (await req.json().catch(() => ({}))) as {
        name?: string;
        scopes?: string[];
        expiresAt?: string | null;
      };
      const created = await createApiToken({
        name: body.name,
        scopes: body.scopes,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        tenantId: auth.tenantId,
        createdBy: auth.prefix,
      });
      return okCreated(created);
    } catch (error) {
      return fail(error);
    }
  },
);