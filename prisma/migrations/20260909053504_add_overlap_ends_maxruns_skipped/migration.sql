-- AlterTable
ALTER TABLE `task` ADD COLUMN `ends_at` DATETIME(6) NULL,
    ADD COLUMN `max_runs` INTEGER NULL,
    ADD COLUMN `overlap_policy` VARCHAR(16) NOT NULL DEFAULT 'skip';

-- AlterTable
ALTER TABLE `task_execution` MODIFY `status` ENUM('pending', 'running', 'succeeded', 'failed', 'timeout', 'dead', 'interrupted', 'skipped') NOT NULL DEFAULT 'pending';
