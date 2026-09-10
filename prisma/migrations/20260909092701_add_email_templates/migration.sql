-- AlterTable
ALTER TABLE `email_log` ADD COLUMN `attachment_url` VARCHAR(512) NULL;

-- AlterTable
ALTER TABLE `task` ADD COLUMN `email_attachment_url_template` VARCHAR(512) NULL,
    ADD COLUMN `email_body_template` TEXT NULL,
    ADD COLUMN `email_subject_template` VARCHAR(255) NULL;
