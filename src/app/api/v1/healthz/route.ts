import { NextResponse } from "next/server";

/**
 * 存活探针（contracts/api.md §10）：不检查依赖。
 * GET /api/v1/healthz → 200 { status: "ok" }
 */

export const runtime = "nodejs";

export function GET(): NextResponse {
  return NextResponse.json({ status: "ok" });
}