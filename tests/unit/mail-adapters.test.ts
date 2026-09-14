import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../../src/lib/config";
import { HttpError } from "../../src/lib/errors";

const fakeTransporter = {
  verify: vi.fn(async () => undefined),
  sendMail: vi.fn(async () => ({ messageId: "m1@test", response: "220 ok" })),
};

vi.mock("nodemailer", () => ({
  default: { createTransport: vi.fn(() => fakeTransporter) },
  createTransport: vi.fn(() => fakeTransporter),
}));

afterEach(() => {
  vi.restoreAllMocks();
  config.MAIL_HTTP_URL = undefined;
});

describe("SmtpMailService", async () => {
  const { SmtpMailService } = await import("../../src/mail/smtp-mail.service");

  it("verifies and sends via transporter", async () => {
    const svc = new SmtpMailService();
    fakeTransporter.verify.mockClear();
    fakeTransporter.sendMail.mockClear();
    await expect(svc.verify()).resolves.toBeUndefined();
    const result = await svc.send({
      to: ["a@example.com"],
      subject: "s",
      html: "<p>h</p>",
      text: "t",
      externalRef: "run-1",
    });
    expect(result.status).toBe("sent");
    expect(result.messageId).toBe("m1@test");
    expect(fakeTransporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["a@example.com"],
        headers: expect.objectContaining({ "X-Scheduled-Run-Id": "run-1" }),
      }),
    );
  });

  it("returns failed status when provider throws", async () => {
    const thrown = Object.assign(new Error("smtp down"), { code: "ECONNECTION" });
    fakeTransporter.sendMail.mockRejectedValueOnce(thrown);
    const svc = new SmtpMailService();
    const result = await svc.send({ to: ["a@x.io"], subject: "s", html: "h", text: "t" });
    expect(result.status).toBe("failed");
    expect(result.messageId).toBeNull();
    // P0-1：透传原始 error，relay 可据 code 分类重试
    expect(result.error).toBe(thrown);
    expect(result.providerResponse).toMatch(/ECONNECTION/);
  });
});

describe("HttpMailService", async () => {
  const { HttpMailService } = await import("../../src/mail/http-mail.service");

  it("throws in verify when URL missing", async () => {
    config.MAIL_HTTP_URL = undefined;
    await expect(new HttpMailService().verify()).rejects.toThrow("MAIL_HTTP_URL");
  });

  it("posts to the provider and returns messageId", async () => {
    config.MAIL_HTTP_URL = "http://mail.test/send";
    config.MAIL_HTTP_TOKEN = "tok";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ messageId: "http-1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const svc = new HttpMailService();
    const result = await svc.send({
      to: ["a@x.io"],
      subject: "s",
      html: "h",
      text: "t",
      externalRef: "run-2",
    });
    expect(result.status).toBe("sent");
    expect(result.messageId).toBe("http-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://mail.test/send");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok" });
    const body = JSON.parse(String(init.body)) as { idempotency_key: string };
    expect(body.idempotency_key).toBe("run-2");
  });

  it("returns failed on non-ok response", async () => {
    config.MAIL_HTTP_URL = "http://mail.test/send";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const result = await new HttpMailService().send({
      to: ["a@x.io"],
      subject: "s",
      html: "h",
      text: "t",
    });
    expect(result.status).toBe("failed");
    // P0-1：非 2xx 透传带 status 的 HttpError，relay 可判 5xx 重试
    expect(result.error).toBeInstanceOf(HttpError);
    expect((result.error as HttpError).status).toBe(500);
  });
});

describe("PickupMailService", async () => {
  const { PickupMailService } = await import("../../src/mail/pickup-mail.service");

  it("sends via sendmail transport", async () => {
    fakeTransporter.sendMail.mockClear();
    const svc = new PickupMailService();
    const result = await svc.send({ to: ["a@x.io"], subject: "s", html: "h", text: "t" });
    expect(result.status).toBe("sent");
    expect(fakeTransporter.sendMail).toHaveBeenCalled();
  });
});