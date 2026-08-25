import { fail, ok, okCreated } from "@/lib/api-envelope";
import { optionalAuth, requireAuth } from "@/modules/auth/middleware";
import * as taskService from "@/modules/task/service";
import type { NextRequest } from "next/server";

/**
 * Tasks 资源（contracts/api.md §1/§2）。
 * GET  /api/v1/tasks?page=&pageSize=&enabled=&type=&q=&mine=&owner= → 分页列表
 *      默认（匿名或登录）→ 跨租户全量，按 viewer 标注 writable（非本租户=只读）。
 *      ?mine=true + 已登录 → 仅当前 token 所属租户的任务（组共享，同租户可写）。
 *      ?owner=token + 已登录 → 仅当前登录 token 自己创建的任务（owner_token_id）。
 *      mine 与 owner 可叠加：租户内再按创建 token 收敛。未登录时两者均忽略。
 * POST /api/v1/tasks → 201 创建（须 token；归属调用方 tenant_id + owner_token_id，不接受请求体传）
 */

export const runtime = "nodejs";

export const GET = optionalAuth(async (req: NextRequest, auth): Promise<Response> => {
  try {
    const { searchParams } = new URL(req.url);
    const page = Number(searchParams.get("page") ?? "1");
    const pageSize = Number(searchParams.get("pageSize") ?? "20");
    const enabled =
      searchParams.get("enabled") === null ? undefined : searchParams.get("enabled") === "true";
    const taskType = searchParams.get("type") ?? undefined;
    const q = searchParams.get("q") ?? undefined;
    const mine = searchParams.get("mine") === "true";
    const ownerToken = searchParams.get("owner") === "token";

    const query = {
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 20,
      enabled,
      taskType,
      q,
      // 仅登录时按当前 token 收敛；未登录忽略 owner=token（保持全量只读）
      ownerTokenId: ownerToken && auth ? auth.tokenId : undefined,
    };
    // ?mine=true + 已登录 → 仅本租户（全部可写）。
    // 否则（匿名或登录默认）→ 跨租户全量，按 viewer 标注 writable。
    const result =
      auth && mine
        ? await taskService.list(auth.tenantId, query)
        : await taskService.listAll(auth?.tenantId ?? null, query);
    return ok(result.data, result.meta);
  } catch (error) {
    return fail(error);
  }
});

export const POST = requireAuth({ scopes: ["tasks:write"] })(
  async (req: NextRequest, auth): Promise<Response> => {
    try {
      const body = await req.json();
      const task = await taskService.create(auth.tenantId, auth.tokenId, body);
      return okCreated(task);
    } catch (error) {
      return fail(error);
    }
  },
);
