import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { generateToken, hashToken, safeEqual, type GeneratedToken } from "./tokens";

/**
 * API-token 服务（research.md §9 / contracts T1-T4）。
 * - 生成：明文仅返回一次；存储仅哈希 + prefix/last_four。
 * - 校验：sha256 → 查 token_hash（未吊销未过期）→ timingSafeEqual → 更新 last_used_at。
 * - scope：写操作需对应 scope（tasks:read / tasks:write / tokens:manage）。
 */

export const SCOPES = ["tasks:read", "tasks:write", "tokens:manage"] as const;
export type Scope = (typeof SCOPES)[number];

export interface AuthContext {
  tokenId: string;
  tenantId: string;
  scopes: string[];
  prefix: string;
  lastFour: string;
  expiresAt: Date | null;
}

export interface CreateTokenInput {
  name?: string;
  scopes?: string[];
  expiresAt?: Date | null;
  tenantId: string;
  createdBy?: string;
}

export interface TokenOutput {
  id: string;
  prefix: string;
  lastFour: string;
  name: string | null;
  scopes: string[];
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface CreatedToken extends TokenOutput {
  /** 明文 token，仅创建时返回一次。 */
  token: string;
}

function assertValidScopes(input: string[]): void {
  const allowed = new Set<string>(SCOPES);
  for (const scope of input) {
    if (!allowed.has(scope)) {
      throw new AppError(400, "VALIDATION", `unknown scope: ${scope}`, [scope]);
    }
  }
}

export async function createApiToken(input: CreateTokenInput): Promise<CreatedToken> {
  assertValidScopes(input.scopes ?? []);

  const generated: GeneratedToken = generateToken();
  const row = await prisma.apiToken.create({
    data: {
      tokenHash: generated.tokenHash,
      prefix: generated.prefix,
      lastFour: generated.lastFour,
      name: input.name,
      scopes: input.scopes ?? [],
      tenantId: input.tenantId,
      expiresAt: input.expiresAt,
      createdBy: input.createdBy,
    },
  });

  return {
    id: row.id,
    token: generated.raw, // 明文仅此一次
    prefix: row.prefix,
    lastFour: row.lastFour,
    name: row.name,
    scopes: row.scopes as string[],
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/** 校验 raw token → AuthContext（未吊销、未过期、常数时间比较）。失败返回 null。 */
export async function authenticateToken(rawToken: string): Promise<AuthContext | null> {
  if (!rawToken) {
    return null;
  }
  const tokenHash = hashToken(rawToken);
  const row = await prisma.apiToken.findUnique({ where: { tokenHash } });
  if (!row) {
    return null;
  }
  if (row.revokedAt) {
    return null;
  }
  if (row.expiresAt && row.expiresAt < new Date()) {
    return null;
  }
  // 常数时间比较（row 已按哈希命中；此步防时序侧信道）
  if (!safeEqual(row.tokenHash, tokenHash)) {
    return null;
  }
  // 更新 last_used_at（失败不影响鉴权结果）
  await prisma.apiToken
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
  return {
    tokenId: row.id,
    tenantId: row.tenantId,
    scopes: row.scopes as string[],
    prefix: row.prefix,
    lastFour: row.lastFour,
    expiresAt: row.expiresAt,
  };
}

export async function listTokens(tenantId: string): Promise<TokenOutput[]> {
  const rows = await prisma.apiToken.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toTokenOutput);
}

export async function revokeToken(tenantId: string, id: string): Promise<boolean> {
  // 幂等：不存在/已吊销 → false，但调用方按 204 处理
  const result = await prisma.apiToken.updateMany({
    where: { id, tenantId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count > 0;
}

export async function getWhoami(tokenId: string): Promise<TokenOutput | null> {
  const row = await prisma.apiToken.findUnique({ where: { id: tokenId } });
  return row ? toTokenOutput(row) : null;
}

function toTokenOutput(row: {
  id: string;
  prefix: string;
  lastFour: string;
  name: string | null;
  scopes: unknown;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}): TokenOutput {
  return {
    id: row.id,
    prefix: row.prefix,
    lastFour: row.lastFour,
    name: row.name,
    scopes: row.scopes as string[],
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}