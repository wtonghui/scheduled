-- CreateTable
CREATE TABLE `tenant` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `cron` VARCHAR(64) NULL,
    `schedule_interval_seconds` INTEGER NULL,
    `task_type` ENUM('http', 'noop') NOT NULL DEFAULT 'http',
    `payload` JSON NOT NULL,
    `payload_secrets` LONGBLOB NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `max_attempts` INTEGER NOT NULL DEFAULT 3,
    `timeout_ms` INTEGER NOT NULL DEFAULT 30000,
    `recipients` JSON NOT NULL,
    `notify_on` JSON NOT NULL,
    `webhook_url` TEXT NULL,
    `webhook_secret` LONGBLOB NULL,
    `next_run_at` DATETIME(6) NULL,
    `claimed_by` VARCHAR(64) NULL,
    `claimed_until` DATETIME(6) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `tenant_id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `task_next_run_at_enabled_idx`(`next_run_at`, `enabled`),
    INDEX `task_claimed_until_idx`(`claimed_until`),
    INDEX `task_tenant_id_next_run_at_idx`(`tenant_id`, `next_run_at`),
    INDEX `task_tenant_id_enabled_idx`(`tenant_id`, `enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_execution` (
    `id` VARCHAR(191) NOT NULL,
    `task_id` VARCHAR(191) NOT NULL,
    `idempotency_key` VARCHAR(255) NOT NULL,
    `scheduled_at` DATETIME(6) NOT NULL,
    `started_at` DATETIME(6) NULL,
    `finished_at` DATETIME(6) NULL,
    `status` ENUM('pending', 'running', 'succeeded', 'failed', 'timeout', 'dead', 'interrupted') NOT NULL DEFAULT 'pending',
    `attempt` INTEGER NOT NULL,
    `duration_ms` INTEGER NULL,
    `error` JSON NULL,
    `trigger` VARCHAR(16) NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    UNIQUE INDEX `task_execution_idempotency_key_key`(`idempotency_key`),
    INDEX `task_execution_task_id_started_at_idx`(`task_id`, `started_at`),
    INDEX `task_execution_status_started_at_idx`(`status`, `started_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `email_log` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `run_id` VARCHAR(255) NOT NULL,
    `task_id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `to_address` TEXT NOT NULL,
    `subject` VARCHAR(255) NOT NULL,
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

    UNIQUE INDEX `email_log_run_id_key`(`run_id`),
    INDEX `email_log_status_next_retry_at_idx`(`status`, `next_retry_at`),
    INDEX `email_log_tenant_id_idx`(`tenant_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `api_token` (
    `id` VARCHAR(191) NOT NULL,
    `token_hash` VARCHAR(128) NOT NULL,
    `prefix` VARCHAR(16) NOT NULL,
    `last_four` VARCHAR(8) NOT NULL,
    `name` VARCHAR(191) NULL,
    `scopes` JSON NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `revoked_at` DATETIME(6) NULL,
    `last_used_at` DATETIME(6) NULL,
    `expires_at` DATETIME(6) NULL,
    `created_by` VARCHAR(191) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    UNIQUE INDEX `api_token_token_hash_key`(`token_hash`),
    INDEX `api_token_prefix_idx`(`prefix`),
    INDEX `api_token_revoked_at_idx`(`revoked_at`),
    INDEX `api_token_tenant_id_idx`(`tenant_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_delivery` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `run_id` VARCHAR(255) NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `webhook_url` TEXT NOT NULL,
    `payload` JSON NOT NULL,
    `status` ENUM('pending', 'in_progress', 'sent', 'failed', 'dead') NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `max_attempts` INTEGER NOT NULL DEFAULT 5,
    `signature` VARCHAR(255) NULL,
    `response_code` INTEGER NULL,
    `last_error` TEXT NULL,
    `next_retry_at` DATETIME(6) NULL,
    `sent_at` DATETIME(6) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    UNIQUE INDEX `webhook_delivery_run_id_key`(`run_id`),
    INDEX `webhook_delivery_status_next_retry_at_idx`(`status`, `next_retry_at`),
    INDEX `webhook_delivery_tenant_id_idx`(`tenant_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `worker_lease` (
    `instance_id` VARCHAR(64) NOT NULL,
    `last_heartbeat_at` DATETIME(6) NOT NULL,
    `claimed_run_ids` JSON NULL,
    `status` VARCHAR(16) NOT NULL,

    INDEX `worker_lease_last_heartbeat_at_idx`(`last_heartbeat_at`),
    PRIMARY KEY (`instance_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `task` ADD CONSTRAINT `task_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_execution` ADD CONSTRAINT `task_execution_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `email_log` ADD CONSTRAINT `email_log_run_id_fkey` FOREIGN KEY (`run_id`) REFERENCES `task_execution`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `email_log` ADD CONSTRAINT `email_log_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `api_token` ADD CONSTRAINT `api_token_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `webhook_delivery` ADD CONSTRAINT `webhook_delivery_run_id_fkey` FOREIGN KEY (`run_id`) REFERENCES `task_execution`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `webhook_delivery` ADD CONSTRAINT `webhook_delivery_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
