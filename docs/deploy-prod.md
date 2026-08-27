# 生产部署与数据库运维（Docker + PM2）

部署形态：**单应用镜像 + 容器内 PM2 守护 web/worker 双进程**，数据库为**已有独立 MySQL**，入口直接暴露端口（宿主 8080 → 容器 3000）。

## 关键文件

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 多阶段生产镜像（runtime 只装 production 依赖，含 pm2/prisma/tsx） |
| `ecosystem.config.cjs` | 容器内 PM2 双进程：web(`next start`) + worker(`tsx worker/index.ts`) |
| `docker-entrypoint.sh` | PID1：先 `prisma migrate deploy`（幂等），再 `pm2-runtime` 前台起双进程 |
| `docker-compose.prod.yml` | 单容器编排：暴露 8080、`env_file: .env.production`、healthz 探活 |

## 一、前期：准备数据库（在已有 MySQL 上执行）

建库 + 最小账号授权（需 DDL 以便 migrate/seed；业务只需该库权限）：

```sql
CREATE DATABASE IF NOT EXISTS scheduled
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'scheduled'@'%' IDENTIFIED BY '<强密码>';
GRANT ALL PRIVILEGES ON scheduled.* TO 'scheduled'@'%';
FLUSH PRIVILEGES;
```

> 连接串务必带 `timezone=Z`（应用会话强制 UTC，调度自洽）。库可以通过 `SET time_zone` 自便，应用不受影响。

## 二、首次部署

> 推荐一键脚本：`./scripts/deploy.sh`（预检 → 构建 → 启动 → 等 healthy → 验证 readyz）。
> Claude 会话内也可直接输入 `/deploy`（参数：`--dry-run` / `--no-build` / `--env=…` / `--port=…`）。

```bash
# 1) 准备生产环境变量（不要提交仓库）
cp .env.production.example .env.production
#   填入 DATABASE_URL / APP_BOOTSTRAP_TOKEN / PAYLOAD_ENCRYPTION_KEY / 邮件项

# 2) 构建并启动（entrypoint 会自动执行 prisma migrate deploy）
docker compose -f docker-compose.prod.yml up -d --build

# 3) 必跑：种子（仅引导 default 租户 + bootstrap token，不插入任务）
docker compose -f docker-compose.prod.yml run --rm scheduled npx tsx prisma/seed.ts
```

> bootstrap：`ensureBootstrap` 只在 seed 内被调用（web/worker 启动不做 bootstrap）——库为空时会创建 `default` 租户 + 把 `APP_BOOTSTRAP_TOKEN` 哈希写入 `api_token`（幂等）。WEB 控制台登录用该 token。

## 三、验证

```bash
docker compose -f docker-compose.prod.yml ps          # 应为 healthy
curl -i http://localhost:8080/api/v1/healthz          # 存活 → 200
curl -i http://localhost:8080/api/v1/readyz           # 就绪（db+mail check）→ 200 或 503 查看 details
curl  -o /dev/null -w '%{http_code}\n' http://localhost:8080/tasks   # 200
docker compose -f docker-compose.prod.yml exec scheduled pm2 list    # web、worker 两个 app 均 online
```

## 四、数据库升级（schema 变更）

```bash
# 自动：重新构建并重启，entrypoint 会先 prisma migrate deploy 再起进程
docker compose -f docker-compose.prod.yml up -d --build
# 手动（一次性，不重启应用）：
docker compose -f docker-compose.prod.yml run --rm scheduled npx prisma migrate deploy
```

> 多副本/扩容注意：web 每次启动都会先跑 migrate——多副本同时迁移有锁竞争风险。
> 权威做法：先单独 `run --rm scheduled npx prisma migrate deploy` 一次，再扩副本。

## 五、数据库备份 / 恢复（在 MySQL 侧执行）

```bash
# 备份（示例：每天 02:00 可加 crontab）
mysqldump -h <DB_HOST> -u scheduled -p scheduled \
  --single-transaction --routines --triggers \
  > backup_scheduled_$(date +%F).sql

# 恢复
mysql -h <DB_HOST> -u scheduled -p scheduled < backup_scheduled_YYYY-MM-DD.sql
```

建议：既有 MySQL 侧的日常备份策略（binlog/自动 mysqldump）由 DBA/运维统一管理，本服务不另起备份容器。

## 六、运维提示

- **连接串 `timezone=Z` 勿删**：删了容器 +08 时会话与 `NOW()` 差 8h。
- **裸 mysql2 传 Date 有 ±8h 偏移**：运维/恢复脚本请用 SQL 端时间（`DATE_ADD(NOW(), ...)`）或走 Prisma，勿裸传 JS Date。
- **日志**：`docker compose -f docker-compose.prod.yml logs -f --tail=200 scheduled`；容器内也可 `pm2 logs web` / `pm2 logs worker`。
- **升级应用** = 整体替换镜像：`docker compose ... up -d --build`，一次性换掉新旧代码进程（PM2 双进程随容器同生共死），避免宿主机残留旧进程。
- **密钥轮换**：`PAYLOAD_ENCRYPTION_KEY` 变更后历史密文不可读；`APP_BOOTSTRAP_TOKEN` 变更不影响已签发 token。
- 环境变量改动后须重启容器：`docker compose -f docker-compose.prod.yml restart`。