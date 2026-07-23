/**
 * 总览面板的品种全集：每个品种同时挂在"地区"和"资产类别"两个维度上，
 * 前端据此做汇总热力图，服务端据此决定轮询范围。
 */

export type Region = 'cn' | 'us' | 'eu' | 'jp' | 'apac' | 'em' | 'global';
export type AssetClass = 'metal' | 'energy' | 'fx' | 'equity' | 'rates';

export interface Instrument {
  code: string;
  label: string;
  region: Region;
  asset: AssetClass;
  /** 轮询权重，越大越优先刷新。 */
  weight?: number;
}

export const REGION_LABEL: Record<Region, string> = {
  cn: '中国',
  us: '美国',
  eu: '欧洲',
  jp: '日本',
  apac: '亚太',
  em: '新兴市场',
  global: '全球大宗',
};

export const ASSET_LABEL: Record<AssetClass, string> = {
  metal: '贵金属 / 工业金属',
  energy: '能源',
  fx: '外汇',
  equity: '股指',
  rates: '利率',
};

/**
 * 默认总览宇宙。
 * 权重 2 的是宏观定价的锚（美元、黄金、原油、美股、中国），刷新更勤。
 */
export const UNIVERSE: Instrument[] = [
  // 全球大宗
  { code: 'XAUUSD', label: '现货黄金', region: 'global', asset: 'metal', weight: 3 },
  { code: 'XAGUSD', label: '现货白银', region: 'global', asset: 'metal', weight: 2 },
  { code: 'XPTUSD', label: '现货铂金', region: 'global', asset: 'metal' },
  { code: 'XPDUSD', label: '现货钯金', region: 'global', asset: 'metal' },
  { code: 'COPPER', label: '现货铜', region: 'global', asset: 'metal', weight: 2 },
  { code: 'USOIL', label: 'WTI 原油', region: 'global', asset: 'energy', weight: 3 },
  { code: 'UKOIL', label: '布伦特原油', region: 'global', asset: 'energy', weight: 2 },
  { code: 'NGAS', label: '天然气', region: 'global', asset: 'energy' },

  // 美国
  { code: 'SPX', label: '标普500', region: 'us', asset: 'equity', weight: 3 },
  { code: 'DJI', label: '道琼斯', region: 'us', asset: 'equity', weight: 2 },

  // 中国
  { code: '000001', label: '上证指数', region: 'cn', asset: 'equity', weight: 3 },
  { code: '399001', label: '深证成指', region: 'cn', asset: 'equity' },
  { code: '399006', label: '创业板指', region: 'cn', asset: 'equity' },
  { code: '000300', label: '沪深300', region: 'cn', asset: 'equity', weight: 2 },
  { code: 'HSI', label: '恒生指数', region: 'cn', asset: 'equity', weight: 2 },
  { code: 'USDCNH', label: '美元/离岸人民币', region: 'cn', asset: 'fx', weight: 3 },

  // 欧洲
  { code: 'GDAXI', label: '德国DAX30', region: 'eu', asset: 'equity' },
  { code: 'FCHI', label: '法国CAC40', region: 'eu', asset: 'equity' },
  { code: 'FTSE', label: '英国富时100', region: 'eu', asset: 'equity' },
  { code: 'EURUSD', label: '欧元/美元', region: 'eu', asset: 'fx', weight: 3 },
  { code: 'GBPUSD', label: '英镑/美元', region: 'eu', asset: 'fx', weight: 2 },
  { code: 'USDCHF', label: '美元/瑞郎', region: 'eu', asset: 'fx' },

  // 日本
  { code: 'N225', label: '日经225', region: 'jp', asset: 'equity', weight: 2 },
  { code: 'USDJPY', label: '美元/日元', region: 'jp', asset: 'fx', weight: 3 },

  // 亚太
  { code: 'KS11', label: '韩国KOSPI', region: 'apac', asset: 'equity' },
  { code: 'AXJO', label: '澳洲ASX200', region: 'apac', asset: 'equity' },
  { code: 'AUDUSD', label: '澳元/美元', region: 'apac', asset: 'fx', weight: 2 },
  { code: 'NZDUSD', label: '纽元/美元', region: 'apac', asset: 'fx' },
  { code: 'USDCAD', label: '美元/加元', region: 'apac', asset: 'fx' },

  // 新兴市场
  { code: 'BSESN', label: '印度SENSEX', region: 'em', asset: 'equity' },
  { code: 'BVSP', label: '巴西BOVESPA', region: 'em', asset: 'equity' },
  { code: 'MXX', label: '墨西哥IPC', region: 'em', asset: 'equity' },
  { code: 'JKSE', label: '印尼综合', region: 'em', asset: 'equity' },
];

export const UNIVERSE_CODES = UNIVERSE.map((i) => i.code);

/**
 * 核心 9 品种 —— 宏观定价的锚。
 *
 * 这个数字不是拍脑袋：get_quote + get_kline 合计 2700 次/天 ≈ 每 32 秒一次调用，
 * 想让一个品种 5 分钟刷新一次就要 288 次/天，2700 ÷ 288 ≈ 9。
 * 也就是说「24 小时不间断 + 5 分钟刷新」的覆盖上限恰好是 9 个品种。
 */
export const CORE_CODES = [
  'XAUUSD', // 现货黄金
  'XAGUSD', // 现货白银
  'USOIL', // WTI 原油
  'USDCNH', // 离岸人民币
  'USDJPY', // 美元/日元
  'EURUSD', // 欧元/美元
  'SPX', // 标普500
  '000001', // 上证指数
  'HSI', // 恒生指数
];

export type Scope = 'core' | 'full';

export const INSTRUMENT_BY_CODE = new Map(UNIVERSE.map((i) => [i.code, i]));

/** 每个品种在轮询环里的权重，未列入宇宙的自选默认 1。 */
export function weightOf(code: string): number {
  return INSTRUMENT_BY_CODE.get(code)?.weight ?? 1;
}
