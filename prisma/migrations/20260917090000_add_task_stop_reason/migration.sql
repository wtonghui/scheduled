-- AlterTable
ALTER TABLE `task` ADD COLUMN `disabled_reason` ENUM('manual', 'run_once_done', 'ends_at', 'max_runs', 'no_future_schedule', 'unknown') NULL,
    ADD COLUMN `disabled_at` DATETIME(6) NULL,
    ADD COLUMN `disabled_by` VARCHAR(191) NULL;
