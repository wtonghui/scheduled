-- 任务 2：task 认领读覆盖（enabled + 到期 + 租约三条件）。
-- COUNT 子查询经 EXPLAIN 走 task_id 前缀，retention 截断后够用，本次不加执行表索引（量了再加）。
-- outbox 回收改走 nextRetryAt deadline（复用现有 (status, next_retry_at) 索引），零新增索引。
CREATE INDEX `task_enabled_next_run_at_claimed_until_idx` ON `task` (`enabled`, `next_run_at`, `claimed_until`);
