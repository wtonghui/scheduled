/*
  Warnings:

  - Added the required column `owner_token_id` to the `task` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `task` ADD COLUMN `owner_token_id` VARCHAR(191) NOT NULL;

-- Backfill: existing tasks belong to the earliest issued token (bootstrap)
UPDATE `task` SET `owner_token_id` = (
  SELECT `id` FROM `api_token` ORDER BY `created_at` ASC LIMIT 1
);

-- CreateIndex
CREATE INDEX `task_owner_token_id_idx` ON `task`(`owner_token_id`);

-- AddForeignKey
ALTER TABLE `task` ADD CONSTRAINT `task_owner_token_id_fkey` FOREIGN KEY (`owner_token_id`) REFERENCES `api_token`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
