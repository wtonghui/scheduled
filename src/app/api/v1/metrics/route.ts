import { register } from "@/lib/metrics";

/**
 * Prometheus 指标端点（contracts/api.md §12）：
 * GET /api/v1/metrics → text/plain; version=0.0.4
 */

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const body = await register.metrics();
  return new Response(body, {
    status: 200,
    headers: { "content-type": register.contentType },
  });
}