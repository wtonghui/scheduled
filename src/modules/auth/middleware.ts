import type { NextRequest } from "next/server";
import { unauthorized, forbidden } from "@/lib/api-envelope";
import { authenticateToken, type AuthContext } from "./service";

/**
 * API 鉴权中间件（Next 15+ route handler 包装）。
 * - `x-api-token` 头 → authenticateToken → AuthContext（tenant_id 注入）。
 * - 可选 scope 校验：缺失 → 403。
 * - 透传第三个参数 ctx（{ params }）供动态路由使用。
 */

export type AuthedHandler<Ctx = unknown> = (
  req: NextRequest,
  auth: AuthContext,
  ctx: Ctx,
) => Promise<Response>;

export interface RequireAuthOptions {
  scopes?: string[];
}

export function requireAuth(options: RequireAuthOptions = {}) {
  return <Ctx = unknown>(handler: AuthedHandler<Ctx>) =>
    async (req: NextRequest, ctx: Ctx): Promise<Response> => {
      const rawToken = req.headers.get("x-api-token");
      if (!rawToken) {
        return unauthorized("missing x-api-token");
      }

      const auth = await authenticateToken(rawToken);
      if (!auth) {
        return unauthorized("invalid or revoked token");
      }

      if (options.scopes && options.scopes.length > 0) {
        const authScopes = new Set(auth.scopes);
        const missing = options.scopes.filter((scope) => !authScopes.has(scope));
        if (missing.length > 0) {
          return forbidden(`missing scope: ${missing.join(", ")}`);
        }
      }

      return handler(req, auth, ctx);
    };
}

/**
 * 可选鉴权中间件：用于受信网络下「匿名只读浏览」场景。
 * - 无 token 头 → auth = null（匿名只读，handler 自行处理）。
 * - 有 token 头但无效/已吊销 → 401（不静默降级为匿名，避免掩盖失效 token）。
 * - 有 token 且有效 → AuthContext（handler 可据此走租户隔离视图）。
 *
 * 注意：仅用于只读端点；写端点必须用 requireAuth。
 */
export type OptionalAuthedHandler<Ctx = unknown> = (
  req: NextRequest,
  auth: AuthContext | null,
  ctx: Ctx,
) => Promise<Response>;

export function optionalAuth<Ctx = unknown>(handler: OptionalAuthedHandler<Ctx>) {
  return async (req: NextRequest, ctx: Ctx): Promise<Response> => {
    const rawToken = req.headers.get("x-api-token");
    if (!rawToken) {
      return handler(req, null, ctx);
    }
    const auth = await authenticateToken(rawToken);
    if (!auth) {
      return unauthorized("invalid or revoked token");
    }
    return handler(req, auth, ctx);
  };
}