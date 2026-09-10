/*
  Warnings:

  - Added the required column `updated_at` to the `webhook_delivery` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `webhook_delivery` ADD COLUMN `updated_at` DATETIME(6) NOT NULL;
