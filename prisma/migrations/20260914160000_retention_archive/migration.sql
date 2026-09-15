-- retention 归档（任务 5）：三张归档表与活表同列，供 90 天规则搬运。
-- 注意三点：① 无 FK（删任务时应用层顺手清归档）；② 只有 task_id 索引（按任务清理/未来按任务查归档）；
-- ③ webhook 归档多 task_id 列（活表经 run_id 间接关联，归档时 join 写死）。
-- schema.prisma 不建归档模型（只走 raw SQL，应用层不可见；migrate deploy 不处理额外表，无漂移问题）。
CREATE TABLE `task_execution_archive` (
    `id` VARCHAR(191) NOT NULL,
    `task_id` VARCHAR(191) NOT NULL,
    `idempotency_key` VARCHAR(255) NOT NULL,
    `scheduled_at` DATETIME(6) NOT NULL,
    `started_at` DATETIME(6) NULL,
    `finished_at` DATETIME(6) NULL,
    `status` ENUM('pending', 'running', 'succeeded', 'failed', 'timeout', 'dead', 'interrupted', 'skipped') NOT NULL DEFAULT 'pending',
    `attempt` INTEGER NOT NULL,
    `duration_ms` INTEGER NULL,
    `error` JSON NULL,
    `trigger` VARCHAR(16) NOT NULL,
    `system_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    INDEX `task_execution_archive_task_id_idx`(`task_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `email_log_archive` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `run_id` VARCHAR(255) NOT NULL,
    `task_id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `to_address` TEXT NOT NULL,
    `subject` VARCHAR(255) NOT NULL,
    `html` TEXT NULL,
    `text` TEXT NULL,
    `status` ENUM('pending', 'in_progress', 'sent', 'failed', 'dead') NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `max_attempts` INTEGER NOT NULL DEFAULT 5,
    `message_id` VARCHAR(255) NULL,
    `provider_response` TEXT NULL,
    `last_error` TEXT NULL,
    `next_retry_at` DATETIME(6) NULL,
    `sent_at` DATETIME(6) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,
    `system_user_id` VARCHAR(191) NULL,
    `attachment_url` VARCHAR(512) NULL,
    INDEX `email_log_archive_task_id_idx`(`task_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `webhook_delivery_archive` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `run_id` VARCHAR(255) NOT NULL,
    `task_id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `webhook_url` TEXT NOT NULL,
    `payload` JSON NOT NULL,
    `webhook_secret` LONGBLOB NULL,
    `status` ENUM('pending', 'in_progress', 'sent', 'failed', 'dead') NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `max_attempts` INTEGER NOT NULL DEFAULT 5,
    `signature` VARCHAR(255) NULL,
    `response_code` INTEGER NULL,
    `last_error` TEXT NULL,
    `next_retry_at` DATETIME(6) NULL,
    `sent_at` DATETIME(6) NULL,
    `system_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,
    INDEX `webhook_delivery_archive_task_id_idx`(`task_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 配额计数列：scheduled/queued 执行创建时 +1（见 createExecution 与 claim 排队分支），
-- 合并翻 skipped 时 -1；归档搬运动它（计数含已归档，配额永不复活）。
ALTER TABLE `task` ADD COLUMN `consumed_runs` INTEGER NOT NULL DEFAULT 0;

-- Backfill：存量按现行计数语义一次算好（attempt=1、scheduled/queued、非 skipped）
UPDATE `task` SET `consumed_runs` = (
  SELECT COUNT(*) FROM `task_execution`
  WHERE `task_execution`.`task_id` = `task`.`id`
    AND `task_execution`.`attempt` = 1
    AND `task_execution`.`trigger` IN ('scheduled', 'queued')
    AND `task_execution`.`status` <> 'skipped'
);
