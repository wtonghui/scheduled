import { fail, ok } from "@/lib/api-envelope";
import { requireAuth } from "@/modules/auth/middleware";
import { previewSpecNextRuns } from "@/modules/task/service";
import type { NextRequest } from "next/server";

/**
 * 未保存配置的下次运行预览（创建/编辑表单用，纯计算不碰库）。
 * POST /api/v1/tasks/preview-next-run → { runs, stopped }
 * 只接受重复调度（cron/interval），runAt 进来就 400。
 */

export const runtime = "nodejs";

export const POST = requireAuth({ scopes: ["tasks:read"] })(
  async (req: NextRequest): Promise<Response> => {
    try {
      const body = (await req.json()) as unknown;
      const result = await previewSpecNextRuns(body);
      return ok(result);
    } catch (error) {
      return fail(error);
    }
  },
);
