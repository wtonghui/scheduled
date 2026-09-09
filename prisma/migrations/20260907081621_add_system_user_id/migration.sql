-- AlterTable
ALTER TABLE `email_log` ADD COLUMN `system_user_id` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `task` ADD COLUMN `system_user_id` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `task_execution` ADD COLUMN `system_user_id` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `webhook_delivery` ADD COLUMN `system_user_id` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `task_tenant_id_system_user_id_enabled_idx` ON `task`(`tenant_id`, `system_user_id`, `enabled`);
