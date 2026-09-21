-- AlterTable
ALTER TABLE `task` ADD COLUMN `email_body_template_failed` TEXT NULL,
    ADD COLUMN `email_subject_template_failed` VARCHAR(255) NULL;
