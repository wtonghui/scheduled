import { NextResponse } from "next/server";
import { generateOpenApiDocument } from "@/lib/openapi";

/**
 * OpenAPI 3 文档（FR-020）：GET /api/v1/docs → application/json
 */

export const runtime = "nodejs";

export function GET(): NextResponse {
  const document = generateOpenApiDocument();
  return NextResponse.json(document, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}