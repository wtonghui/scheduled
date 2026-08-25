import { collectDefaultMetrics, Counter, Gauge, Histogram, register } from "prom-client";

/**
 * Prometheus 指标（NFR-004 / research.md §7），worker 与 web 共用注册表。
 */

collectDefaultMetrics({ register });

export const taskRunsTotal = new Counter({
  name: "scheduled_task_runs_total",
  help: "task runs by terminal status",
  labelNames: ["status"],
});

export const taskAttemptsTotal = new Counter({
  name: "scheduled_task_attempts_total",
  help: "task execution attempts by status",
  labelNames: ["status"],
});

export const taskDurationMs = new Histogram({
  name: "scheduled_task_duration_ms",
  help: "task run duration in milliseconds",
  buckets: [50, 200, 500, 1000, 2500, 5000, 10000, 30000, 60000, 300000],
});

export const taskInFlight = new Gauge({
  name: "scheduled_task_in_flight",
  help: "currently running tasks",
});

export const deadLetterTotal = new Counter({
  name: "scheduled_task_dead_letter_total",
  help: "dead-lettered jobs",
  labelNames: ["task_id"],
});

export const emailSentTotal = new Counter({
  name: "scheduled_email_sent_total",
  help: "emails delivered by the relay",
});

export const emailFailedTotal = new Counter({
  name: "scheduled_email_failed_total",
  help: "emails failed/dead by the relay",
});

export const outboxPending = new Gauge({
  name: "scheduled_outbox_pending",
  help: "pending rows in email_log + webhook_delivery outboxes",
});

export const workerHeartbeats = new Counter({
  name: "scheduled_worker_heartbeats_total",
  help: "worker heartbeats upserts",
  labelNames: ["worker_id"],
});

export { register };