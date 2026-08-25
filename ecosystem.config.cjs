/**
 * 生产容器内 PM2 配置（docker-entrypoint.sh 以 pm2-runtime 前台加载，PM2 即 PID1）。
 * - web：next start（Node 服务）
 * - worker：tsx 常驻（调度/执行/中继）
 * 单实例即可；多 worker 实例的领取安全由 SKIP LOCKED 保证，扩实例时直接 PM2 加实例数。
 */
module.exports = {
  apps: [
    {
      name: "web",
      cwd: "/app",
      script: "node_modules/.bin/next",
      args: "start",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      time: true,
    },
    {
      name: "worker",
      cwd: "/app",
      script: "node_modules/.bin/tsx",
      args: "worker/index.ts",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      time: true,
    },
  ],
};
