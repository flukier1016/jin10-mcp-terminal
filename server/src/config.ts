import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { UNIVERSE_CODES } from './core/universe.js';

// 无论从仓库根还是 server/ 启动，都能找到同一份 .env（Railway 上则走真实环境变量）
const here = path.dirname(fileURLToPath(import.meta.url));
for (const p of [
  path.resolve(process.cwd(), '.env'),
  path.resolve(here, '../../.env'),
  path.resolve(here, '../../../.env'),
]) {
  dotenv.config({ path: p, override: false, quiet: true });
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v: string | undefined, d: boolean) =>
  v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v);

export const config = {
  port: num(process.env.PORT, 8080),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  corsOrigin: process.env.CORS_ORIGIN ?? '',

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
    dailyLimit: num(process.env.WISBURG_DAILY_LIMIT, 1000),
  },

  quota: {
    dailyLimit: num(process.env.DAILY_TOOL_LIMIT, 1500),
    reserveRatio: num(process.env.QUOTA_RESERVE_RATIO, 0.1),
    /**
     * 额度要铺满多少小时。24 = 全天候常驻：
     *   86400s ÷ (1500 × 0.9) = 64s / 次，正好把日额度拉满且不会提前耗尽。
     */
    sustainHours: num(process.env.SUSTAIN_HOURS, 24),
    /** 24/7 模式：没有任何浏览器连着也继续刷新，保证随时打开都是新的。 */
    pollWhenIdle: bool(process.env.POLL_WHEN_IDLE, true),
    /** 是否始终覆盖总览宇宙（而不是只覆盖当前订阅）。 */
    alwaysOnUniverse: bool(process.env.ALWAYS_ON_UNIVERSE, true),
    /** 前台聚焦品种的额外权重倍数。 */
    focusBoost: num(process.env.FOCUS_BOOST, 6),
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
  if (!config.jin10.token) {
    throw new Error('缺少 JIN10_TOKEN 环境变量 —— 请复制 .env.example 为 .env 并填入 Bearer Token');
  }
}

/** 智堡是可选数据源，没配 token 就整块功能关掉，不影响金十终端。 */
export const wisburgEnabled = (): boolean => Boolean(config.wisburg.token);
