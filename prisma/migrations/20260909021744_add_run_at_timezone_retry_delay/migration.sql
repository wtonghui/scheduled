-- AlterTable
ALTER TABLE `task` ADD COLUMN `retry_delay_ms` INTEGER NULL,
    ADD COLUMN `run_at` DATETIME(6) NULL,
    ADD COLUMN `timezone` VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai';
