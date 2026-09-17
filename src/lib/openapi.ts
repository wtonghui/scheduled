import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import type { ParameterObject, SchemaObject } from "openapi3-ts/oas30";

/**
 * OpenAPI 3 文档（FR-020 / T040）：经 OpenApiGeneratorV3 生成，暴露于 /api/v1/docs。
 *
 * 注意：不使用 zod schema 注册（zod-to-openapi 的 CJS 构建内部分开 import 一份 CJS zod，
 * 与 ESM 的 zod 类构成两个实例，extendZodWithOpenApi 无法作用到库侧 schema，
 * 导致任何 register/convert 抛 "openapi is not a function"）。此处全部以纯 OpenAPI 对象声明，
 * 端点契约与 contracts/api.md 保持一致。
 */

const ST: SchemaObject = { type: "string" };
const BOOL: SchemaObject = { type: "boolean" };
const INT: SchemaObject = { type: "integer" };

const registry = new OpenAPIRegistry();

const ErrorEnvelope: SchemaObject = {
  type: "object",
  required: ["success", "error"],
  properties: {
    success: { const: false } as SchemaObject,
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string", example: "VALIDATION" } as SchemaObject,
        message: { type: "string" } as SchemaObject,
        details: { type: "array", items: {} } as SchemaObject,
      },
    } as SchemaObject,
  },
};

const SuccessAny: SchemaObject = { type: "object", additionalProperties: true };

const pageParam: ParameterObject = { name: "page", in: "query", schema: { ...INT, default: 1 } };
const pageSizeParam: ParameterObject = {
  name: "pageSize",
  in: "query",
  schema: { ...INT, default: 20, maximum: 100 },
};
const enabledParam: ParameterObject = { name: "enabled", in: "query", schema: BOOL };
const typeParam: ParameterObject = { name: "type", in: "query", schema: ST };
const qParam: ParameterObject = { name: "q", in: "query", schema: ST };
const idParam: ParameterObject = { name: "id", in: "path", required: true, schema: ST };

registry.registerPath({
  method: "get",
  path: "/api/v1/tasks",
  summary: "List tasks",
  tags: ["tasks"],
  parameters: [pageParam, pageSizeParam, enabledParam, typeParam, qParam],
  responses: {
    200: {
      description: "paginated tasks",
      content: { "application/json": { schema: SuccessAny } },
    },
    401: {
      description: "unauthorized",
      content: { "application/json": { schema: ErrorEnvelope } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/tasks",
  summary: "Create task",
  tags: ["tasks"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["name", "recipients"],
            properties: {
              name: ST,
              cron: { ...ST, example: "*/5 * * * *" },
              scheduleIntervalSeconds: INT,
              runAt: { type: "string", format: "date-time", example: "2027-01-01T09:00:00+08:00" },
              timezone: { ...ST, example: "Asia/Shanghai" },
              retryDelayMs: { ...INT, minimum: 0, maximum: 3600000 },
              overlapPolicy: { type: "string", enum: ["skip", "queue", "run"], default: "skip" },
              endsAt: { type: "string", format: "date-time" },
              maxRuns: { ...INT, minimum: 1 },
              startsAt: { type: "string", format: "date-time" },
              skipHolidays: { type: "boolean", default: false },
              holidayPolicy: { type: "string", enum: ["drop", "postpone"], default: "drop" },
              taskType: { type: "string", enum: ["http", "noop"] },
              payload: { type: "object", additionalProperties: true },
              enabled: BOOL,
              maxAttempts: { ...INT, minimum: 1, maximum: 10, default: 3 },
              timeoutMs: { ...INT, minimum: 1000, default: 30000 },
              recipients: { type: "array", items: { type: "string", format: "email" } },
              notifyOn: {
                type: "array",
                items: { type: "string", enum: ["succeeded", "failed", "succeeded_with_results"] },
              },
              webhookUrl: { type: "string", format: "uri" },
            },
          },
        },
      },
    },
  },
  responses: {
    201: { description: "created", content: { "application/json": { schema: SuccessAny } } },
    400: {
      description: "validation error",
      content: { "application/json": { schema: ErrorEnvelope } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/tasks/{id}",
  summary: "Get task",
  tags: ["tasks"],
  parameters: [idParam],
  responses: {
    200: { description: "task", content: { "application/json": { schema: SuccessAny } } },
    404: { description: "not found", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/tasks/{id}/sign-secrets",
  summary: "Get task sign secrets (plaintext, audited)",
  tags: ["tasks"],
  parameters: [idParam],
  responses: {
    200: { description: "secrets", content: { "application/json": { schema: SuccessAny } } },
    401: {
      description: "unauthorized",
      content: { "application/json": { schema: ErrorEnvelope } },
    },
    404: { description: "not found", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/tasks/{id}/sign-secrets/rotate",
  summary: "Rotate a task sign secret (returns new plaintext once)",
  tags: ["tasks"],
  parameters: [idParam],
  request: {
    body: {
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["key"],
            properties: {
              key: { type: "string", enum: ["webhookSecret", "execSignSecret"] },
            },
          },
        },
      },
    },
  },
  responses: {
    200: { description: "rotated", content: { "application/json": { schema: SuccessAny } } },
    400: {
      description: "validation error",
      content: { "application/json": { schema: ErrorEnvelope } },
    },
    404: { description: "not found", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/tasks/{id}",
  summary: "Update task (optimistic concurrency via version)",
  tags: ["tasks"],
  parameters: [idParam],
  request: {
    body: {
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["version"],
            properties: {
              name: ST,
              enabled: BOOL,
              cron: { ...ST, nullable: true },
              scheduleIntervalSeconds: { ...INT, nullable: true },
              runAt: { type: "string", format: "date-time", nullable: true },
              timezone: { ...ST, nullable: true },
              retryDelayMs: { ...INT, minimum: 0, maximum: 3600000, nullable: true },
              overlapPolicy: { type: "string", enum: ["skip", "queue", "run"] },
              endsAt: { type: "string", format: "date-time", nullable: true },
              maxRuns: { ...INT, minimum: 1, nullable: true },
              resetConsumedRuns: { type: "boolean", enum: [true] },
              startsAt: { type: "string", format: "date-time", nullable: true },
              skipHolidays: { type: "boolean" },
              holidayPolicy: { type: "string", enum: ["drop", "postpone"] },
              version: { ...INT, minimum: 1 },
            },
          },
        },
      },
    },
  },
  responses: {
    200: { description: "updated", content: { "application/json": { schema: SuccessAny } } },
    409: {
      description: "version conflict",
      content: { "application/json": { schema: ErrorEnvelope } },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/tasks/{id}",
  summary: "Delete task",
  tags: ["tasks"],
  parameters: [idParam],
  responses: {
    204: { description: "deleted" },
    404: { description: "not found", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/tasks/{id}/run-now",
  summary: "Run task immediately",
  tags: ["tasks"],
  parameters: [idParam],
  responses: {
    202: { description: "accepted", content: { "application/json": { schema: SuccessAny } } },
    404: { description: "not found", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/tasks/preview-next-run",
  summary: "Preview upcoming runs for an unsaved schedule (cron/interval/runAt, tasks:read)",
  tags: ["tasks"],
  responses: {
    200: { description: "runs", content: { "application/json": { schema: SuccessAny } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/tasks/{id}/executions",
  summary: "Task execution history",
  tags: ["executions"],
  parameters: [idParam, { name: "status", in: "query", schema: ST } satisfies ParameterObject],
  responses: {
    200: { description: "executions", content: { "application/json": { schema: SuccessAny } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/executions",
  summary: "Global execution history",
  tags: ["executions"],
  parameters: [
    { name: "taskId", in: "query", schema: ST } satisfies ParameterObject,
    { name: "status", in: "query", schema: ST } satisfies ParameterObject,
  ],
  responses: {
    200: { description: "executions", content: { "application/json": { schema: SuccessAny } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/email-log",
  summary: "Email log",
  tags: ["notifications"],
  responses: {
    200: { description: "email log", content: { "application/json": { schema: SuccessAny } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/tasks/{id}/webhook-deliveries",
  summary: "Task webhook delivery history",
  tags: ["notifications"],
  parameters: [idParam],
  responses: {
    200: { description: "deliveries", content: { "application/json": { schema: SuccessAny } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/email-log/{id}/redrive",
  summary: "Redrive a dead email (dead → pending, tasks:write)",
  tags: ["notifications"],
  parameters: [idParam],
  responses: {
    200: { description: "redriven row", content: { "application/json": { schema: SuccessAny } } },
    404: { description: "not found", content: { "application/json": { schema: ErrorEnvelope } } },
    409: { description: "not dead", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/webhook-deliveries/{id}/redrive",
  summary: "Redrive a dead webhook delivery (dead → pending, tasks:write)",
  tags: ["notifications"],
  parameters: [idParam],
  responses: {
    200: { description: "redriven row", content: { "application/json": { schema: SuccessAny } } },
    404: { description: "not found", content: { "application/json": { schema: ErrorEnvelope } } },
    409: { description: "not dead", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/healthz",
  summary: "Liveness",
  tags: ["ops"],
  responses: {
    200: { description: "ok", content: { "application/json": { schema: SuccessAny } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/readyz",
  summary: "Readiness",
  tags: ["ops"],
  responses: {
    200: { description: "ready", content: { "application/json": { schema: SuccessAny } } },
    503: { description: "not ready", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/tokens",
  summary: "List API tokens (tokens:manage)",
  tags: ["tokens"],
  responses: {
    200: { description: "tokens", content: { "application/json": { schema: SuccessAny } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/tokens",
  summary: "Create API token (temporary: no auth, single default tenant)",
  tags: ["tokens"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              name: ST,
              scopes: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
  },
  responses: {
    201: {
      description: "created with plaintext token",
      content: { "application/json": { schema: SuccessAny } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/tokens/whoami",
  summary: "Current token info",
  tags: ["tokens"],
  responses: {
    200: { description: "whoami", content: { "application/json": { schema: SuccessAny } } },
  },
});

export function generateOpenApiDocument(): ReturnType<OpenApiGeneratorV3["generateDocument"]> {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.3",
    info: {
      title: "Scheduled Task Manager API",
      version: "1.0.0",
      description:
        "定时任务管理器：CRUD、执行、邮件/Webhook 通知、可观测性。所有端点前缀 /api/v1；鉴权 x-api-token（LLM 风格 API-token）。",
    },
    servers: [{ url: "http://localhost:3000" }],
  });
}
