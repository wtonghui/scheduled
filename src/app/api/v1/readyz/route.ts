import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getMailService } from "@/mail/port";
import type { ApiEnvelope } from "@/lib/api-envelope";

/**
 * 就绪探针（contracts/api.md §11）：DB 连接 + 邮件 provider verify()。
 * 全就绪 200；任一失败 503 { checks: { db, mail } }。
 */

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const checks: Record<string, string> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = "ok";
  } catch {
    checks.db = "fail";
  }

  try {
    await getMailService().verify();
    checks.mail = "ok";
  } catch {
    checks.mail = "fail";
  }

  const ready = Object.values(checks).every((v) => v === "ok");

  if (ready) {
    return NextResponse.json(
      {
        success: true,
        data: { status: "ready", checks },
      } satisfies ApiEnvelope<{ status: string; checks: Record<string, string> }>,
      { status: 200 },
    );
  }

  return NextResponse.json(
    {
      success: false,
      error: { code: "NOT_READY", message: "not ready", details: [checks] },
    } satisfies ApiEnvelope<never>,
    { status: 503 },
  );
}