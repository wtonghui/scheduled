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

export const taskClaimDurationMs = new Histogram({
  name: "scheduled_claim_duration_ms",
  help: "claim round duration in milliseconds by phase (read/write)",
  labelNames: ["phase"],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
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

export const webhookSentTotal = new Counter({
  name: "scheduled_webhook_sent_total",
  help: "webhooks delivered by the relay",
});

export const webhookFailedTotal = new Counter({
  name: "scheduled_webhook_failed_total",
  help: "webhooks failed/dead by the relay",
});

export const outboxPending = new Gauge({
  name: "scheduled_outbox_pending",
  help: "pending rows in email_log + webhook_delivery outboxes",
});

export const outboxFailed = new Gauge({
  name: "scheduled_outbox_failed",
  help: "failed (retryable, awaiting retry) rows in email_log + webhook_delivery outboxes",
});

export const outboxDead = new Gauge({
  name: "scheduled_outbox_dead",
  help: "dead-lettered rows in email_log + webhook_delivery outboxes (need redrive)",
});

export const archiveMovedTotal = new Counter({
  name: "scheduled_archive_moved_total",
  help: "rows moved to *_archive tables by the retention job",
  labelNames: ["table"],
});

export const webhookBreakersOpen = new Gauge({
  name: "scheduled_webhook_breakers_open",
  help: "currently open webhook per-host breakers (shared across pods when backed by Redis)",
});

export const outboxPendingByTenant = new Gauge({
  name: "scheduled_outbox_pending_by_tenant",
  help: "pending+in_progress outbox rows by tenant (fairness skew signal)",
  labelNames: ["tenant"],
});

export const outboxHealedTotal = new Counter({
  name: "scheduled_outbox_healed_total",
  help: "outbox rows backfilled by the heal job",
});

export const workerHeartbeats = new Counter({
  name: "scheduled_worker_heartbeats_total",
  help: "worker heartbeats upserts",
  labelNames: ["worker_id"],
});

export { register };