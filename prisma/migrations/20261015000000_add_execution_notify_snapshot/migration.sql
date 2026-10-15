-- 终态通知意图快照：自愈只认执行行上的期望，不认任务现状（防后开通知误补发旧 run）
ALTER TABLE `task_execution`
  ADD COLUMN `email_expected` BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN `webhook_expected` BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN `notify_snapshot` JSON NULL;

-- 存量回填：以已存在的 outbox 行为准（有行=当时要发），无行=当时不要发；
-- 老数据无快照，heal 见 notify_snapshot IS NULL 直接跳过，只防新数据误发。
UPDATE `task_execution` te
  SET `email_expected` = EXISTS(SELECT 1 FROM `email_log` e WHERE e.`run_id` = te.`id`),
      `webhook_expected` = EXISTS(SELECT 1 FROM `webhook_delivery` w WHERE w.`run_id` = te.`id`)
  WHERE te.`status` IN ('succeeded', 'failed', 'dead', 'timeout');

-- 归档表同列（heal 窗口 7 天远小于归档 90 天，仅保持搬运列一致）。
ALTER TABLE `task_execution_archive`
  ADD COLUMN `email_expected` BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN `webhook_expected` BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN `notify_snapshot` JSON NULL;
