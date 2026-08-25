import type { NextRequest } from "next/server";
import { requireAuth } from "@/modules/auth/middleware";
import { getWhoami } from "@/modules/auth/service";
import { ok, fail } from "@/lib/api-envelope";

/**
 * 当前 token 信息（contracts/api.md T4）：任意有效 token。
 * GET /api/v1/tokens/whoami → { prefix, lastFour, scopes, expiresAt }
 */

export const runtime = "nodejs";

export const GET = requireAuth()(async (_req: NextRequest, auth): Promise<Response> => {
  try {
    const whoami = await getWhoami(auth.tokenId);
    if (!whoami) {
      return ok({});
    }
    return ok({
      prefix: whoami.prefix,
      lastFour: whoami.lastFour,
      scopes: whoami.scopes,
      expiresAt: whoami.expiresAt,
    });
  } catch (error) {
    return fail(error);
  }
});