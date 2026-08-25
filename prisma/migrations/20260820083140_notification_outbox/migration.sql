-- AlterTable
ALTER TABLE `email_log` ADD COLUMN `html` TEXT NULL,
    ADD COLUMN `text` TEXT NULL;

-- AlterTable
ALTER TABLE `webhook_delivery` ADD COLUMN `webhook_secret` LONGBLOB NULL;
