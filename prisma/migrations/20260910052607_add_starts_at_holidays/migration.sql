-- AlterTable
ALTER TABLE `task` ADD COLUMN `holiday_policy` VARCHAR(16) NOT NULL DEFAULT 'drop',
    ADD COLUMN `skip_holidays` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `starts_at` DATETIME(6) NULL;
