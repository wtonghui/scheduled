import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as previewPOST } from "../../src/app/api/v1/tasks/preview-next-run/route";
import { cleanupTenant, createTestTenant, createTestToken } from "../integration/helpers";

/** preview-next-run 路由契约：信封、鉴权、三选一校验。 */

const BASE = "http://localhost/api/v1";

function req(url: string, options: { body?: unknown; token?: string } = {}): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      ...(options.token ? { "x-api-token": options.token } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(options.body ?? {}),
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text());
}

describe("preview-next-run HTTP contract", () => {
  let readToken: string;
  let tenantId: string;

  beforeAll(async () => {
    const tenant = await createTestTenant("contract-preview");
    tenantId = tenant.id;
    readToken = (await createTestToken(tenant.id, ["tasks:read"], "read")).token;
  });

  afterAll(async () => {
    await cleanupTenant(tenantId);
  });

  it("returns 200 with runs for a valid cron spec", async () => {
    const res = await previewPOST(
      req(`${BASE}/tasks/preview-next-run`, {
        token: readToken,
        body: { cron: "0 9 * * *", timezone: "Asia/Shanghai", count: 2 },
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.success).toBe(true);
    const data = body.data as { runs: unknown[]; stopped: unknown };
    expect(data.runs).toHaveLength(2);
    expect(data.stopped).toBeNull();
  });

  it("returns 401 without a token", async () => {
    const res = await previewPOST(
      req(`${BASE}/tasks/preview-next-run`, { body: { cron: "0 9 * * *" } }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 with the single run for a future runAt", async () => {
    const res = await previewPOST(
      req(`${BASE}/tasks/preview-next-run`, {
        token: readToken,
        body: { runAt: new Date(Date.now() + 3_600_000).toISOString() },
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    const data = body.data as { runs: unknown[]; stopped: unknown };
    expect(data.runs).toHaveLength(1);
    expect(data.stopped).toBe("no-future-schedule");
  });

  it("returns 400 for bad specs", async () => {
    for (const body of [
      {},
      { cron: "0 9 * * *", scheduleIntervalSeconds: 60 },
      { cron: "nope" },
      { runAt: new Date(Date.now() - 1000).toISOString() },
      { runAt: new Date(Date.now() + 3600_000).toISOString(), maxRuns: 3 },
    ]) {
      const res = await previewPOST(req(`${BASE}/tasks/preview-next-run`, { token: readToken, body }));
      expect(res.status).toBe(400);
    }
  });
});
