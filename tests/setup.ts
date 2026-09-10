import "dotenv/config";

/**
 * Vitest 全局 setup：在各测试文件导入前设置最小测试环境变量。
 * config.ts 在模块加载时解析 process.env 并 fail-fast，故必须在 import 前准备好。
 * 先加载项目 .env（真实凭据），仅当缺失时填充测试值。
 */
process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "mysql://scheduler:changeme@127.0.0.1:13306/scheduled";

// 32 字节 hex（64 字符）供 AES-256-GCM
process.env.PAYLOAD_ENCRYPTION_KEY ??= "a".repeat(64);

process.env.APP_BOOTSTRAP_TOKEN ??= "test-bootstrap-token-0123456789abcdef";
process.env.TOKEN_PREFIX ??= "sche-";
// 集成测试强制 json 落盘（不真发）：.env 的 smtp/http 仅供本地手动联调，
// 必须无条件覆盖（不能用 ??=，否则 .env 配了 smtp 就会向真实 SMTP 外发邮件——
// 慢、依赖外部服务，还会触发服务商限流；且无网环境下中继恒失败导致用例挂）。
process.env.MAIL_PROVIDER = "json";
process.env.LOG_LEVEL ??= "info";

// 仅测试环境：允许 worker 调用本地测试 HTTP 服务器（生产默认关闭）
process.env.SSRF_ALLOW_PRIVATE ??= "true";
