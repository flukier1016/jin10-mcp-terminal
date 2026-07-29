import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { UNIVERSE_CODES } from './core/universe.js';

// 无论从仓库根还是 server/ 启动，都能找到同一份 .env（Railway 上则走真实环境变量）
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../..');
for (const p of [
  path.resolve(process.cwd(), '.env'),
  path.resolve(here, '../../.env'),
  path.resolve(here, '../../../.env'),
]) {
  dotenv.config({ path: p, override: false, quiet: true });
}

interface NumberOptions {
  min?: number;
  max?: number;
  integer?: boolean;
}

/** 对来自不同部署平台的字符串环境变量做同一套容错和边界保护。 */
export function parseNumber(v: string | undefined, fallback: number, options: NumberOptions = {}): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const value = options.integer ? Math.trunc(n) : n;
  if (options.min !== undefined && value < options.min) return fallback;
  if (options.max !== undefined && value > options.max) return fallback;
  return value;
}

export function parseBoolean(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v.trim() === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  return fallback;
}

/** 支持单域名和逗号分隔的多前端部署；同源模式保持为空。 */
export function parseOrigins(v: string | undefined): string[] {
  return [
    ...new Set(
      (v ?? '')
        .split(',')
        .map((origin) => origin.trim().replace(/\/+$/, ''))
        .filter(Boolean),
    ),
  ];
}

export const config = {
  host: process.env.HOST?.trim() || '0.0.0.0',
  port: parseNumber(process.env.PORT, 8080, { min: 1, max: 65_535, integer: true }),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  demoMode: parseBoolean(process.env.DEMO_MODE, false),
  corsOrigins: parseOrigins(process.env.CORS_ORIGIN),
  stateDir: resolveStateDir(process.env.STATE_DIR),

  /** 金十数据 MCP。 */
  jin10: {
    url: process.env.JIN10_MCP_URL ?? 'https://mcp.jin10.com/mcp',
    token: process.env.JIN10_TOKEN ?? '',
    protocolVersion: process.env.MCP_PROTOCOL_VERSION ?? '2025-11-25',
  },

  /** 智堡 Wisburg MCP（官方也支持 ?api_key= 查询参数，这里用 Bearer 头，不会泄漏到日志）。 */
  wisburg: {
    url: process.env.WISBURG_MCP_URL ?? 'https://mcp.wisburg.com/mcp',
    token: process.env.WISBURG_TOKEN ?? '',
    protocolVersion: process.env.MCP_PROTOCOL_VERSION ?? '2025-11-25',
    /** 智堡未公布每日上限，这里给一个保守的本地保护值，可用环境变量覆盖。 */
    dailyLimit: parseNumber(process.env.WISBURG_DAILY_LIMIT, 1000, { min: 1, max: 1_000_000, integer: true }),
  },

  quota: {
    dailyLimit: parseNumber(process.env.DAILY_TOOL_LIMIT, 1500, { min: 1, max: 1_000_000, integer: true }),
    reserveRatio: parseNumber(process.env.QUOTA_RESERVE_RATIO, 0.1, { min: 0, max: 0.95 }),
    /**
     * 额度要铺满多少小时。24 = 全天候常驻：
     *   86400s ÷ (1500 × 0.9) = 64s / 次，正好把日额度拉满且不会提前耗尽。
     */
    sustainHours: parseNumber(process.env.SUSTAIN_HOURS, 24, { min: 0.25, max: 168 }),
    /** 24/7 模式：没有任何浏览器连着也继续刷新，保证随时打开都是新的。 */
    pollWhenIdle: parseBoolean(process.env.POLL_WHEN_IDLE, true),
    /** 是否始终覆盖总览宇宙（而不是只覆盖当前订阅）。 */
    alwaysOnUniverse: parseBoolean(process.env.ALWAYS_ON_UNIVERSE, true),
    /** 前台聚焦品种的额外权重倍数。 */
    focusBoost: parseNumber(process.env.FOCUS_BOOST, 6, { min: 0.1, max: 100 }),
  },

  watchlist: (process.env.DEFAULT_WATCHLIST ?? 'XAUUSD,XAGUSD,USOIL,UKOIL,USDCNH,USDJPY,EURUSD,COPPER')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),

  universe: UNIVERSE_CODES,

  /**
   * 各轮询任务的间隔上下限（毫秒）。调度器在此区间内按剩余额度自适应，
   * 24/7 模式下稳态值会落在 64 秒附近。
   */
  poll: {
    quote: { min: 30_000, max: 300_000 },
    kline: { min: 30_000, max: 300_000 },
    flash: { min: 30_000, max: 300_000 },
    news: { min: 60_000, max: 900_000 },
    calendar: { min: 300_000, max: 3_600_000 },
  },
} as const;

export function assertConfig(): void {
  if (!config.demoMode && !config.jin10.token) {
    throw new Error('缺少 JIN10_TOKEN 环境变量 —— 请复制 .env.example 为 .env 并填入 Bearer Token');
  }
  if (!config.demoMode) assertHttpUrl('JIN10_MCP_URL', config.jin10.url);
  if (config.wisburg.token) assertHttpUrl('WISBURG_MCP_URL', config.wisburg.url);
  for (const origin of config.corsOrigins) {
    if (origin !== '*') assertHttpUrl('CORS_ORIGIN', origin);
  }
}

/** 智堡是可选数据源，没配 token 就整块功能关掉，不影响金十终端。 */
export const wisburgEnabled = (): boolean => !config.demoMode && Boolean(config.wisburg.token);

function assertHttpUrl(name: string, raw: string): void {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
  } catch {
    throw new Error(`${name} 必须是有效的 http(s) URL`);
  }
}

function resolveStateDir(raw: string | undefined): string {
  const value = raw?.trim() || '.data';
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}
