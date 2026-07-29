import { UNIVERSE } from '../core/universe.js';
import type {
  CalendarEvent,
  FlashItem,
  KlineBar,
  KlineSeries,
  NewsDetail,
  NewsItem,
  Paged,
  Quote,
  QuoteCode,
} from '../types.js';
import type { Jin10Client, Jin10Tool } from './jin10.js';

const BASE_PRICE: Record<string, number> = {
  XAUUSD: 4026.47,
  XAGUSD: 57.504,
  XPTUSD: 1692.4,
  XPDUSD: 1426.8,
  COPPER: 6.3559,
  USOIL: 81.502,
  UKOIL: 85.04,
  NGAS: 3.18,
  SPX: 6388.6,
  DJI: 45112,
  '000001': 3618.2,
  '399001': 11248,
  '399006': 2312,
  '000300': 4216,
  HSI: 25642,
  USDCNH: 6.771,
  GDAXI: 24286,
  FCHI: 7814,
  FTSE: 9124,
  EURUSD: 1.1399,
  GBPUSD: 1.3342,
  USDCHF: 0.8031,
  N225: 41892,
  USDJPY: 163.569,
  KS11: 3268,
  AXJO: 8746,
  AUDUSD: 0.6552,
  NZDUSD: 0.5974,
  USDCAD: 1.3712,
  BSESN: 81420,
  BVSP: 134620,
  MXX: 57312,
  JKSE: 7864,
};

const FLASH_TEXT = [
  '亚太主要股指午盘多数走高，能源与工业金属板块领涨。',
  '美元指数窄幅震荡，市场等待下一项通胀与就业数据。',
  '现货黄金维持区间整理，短端利率预期变化仍是主要驱动。',
  '国际油价延续反弹，交易员关注库存与供应端最新信号。',
  '离岸人民币流动性平稳，主要期限隐含波动率小幅回落。',
  '美债收益率曲线趋陡，长端对财政与通胀风险更为敏感。',
];

const NEWS: NewsItem[] = [
  {
    id: 'demo-1',
    title: '演示观察：跨资产行情进入数据密集窗口',
    introduction: '黄金、原油、外汇与股指的相关性重新抬升，风险管理比单点方向判断更重要。',
    time: new Date(Date.now() - 18 * 60_000).toISOString(),
    url: '',
  },
  {
    id: 'demo-2',
    title: '演示观察：美元与利率定价出现新的分歧',
    introduction: '短端利率预期保持稳定，长端波动则更多受期限溢价与供给预期影响。',
    time: new Date(Date.now() - 52 * 60_000).toISOString(),
    url: '',
  },
  {
    id: 'demo-3',
    title: '演示观察：商品板块强弱分化',
    introduction: '能源品种波动扩大，贵金属仍受避险需求与实际利率的双重牵引。',
    time: new Date(Date.now() - 96 * 60_000).toISOString(),
    url: '',
  },
];

/**
 * 无密钥、无外网依赖的确定性数据源。
 *
 * 它服务于新环境验收、UI 开发、Docker 健康检查与演示，不会伪装成真实行情。
 */
export class DemoJin10Client implements Jin10Client {
  async readResource<T>(uri: string): Promise<T> {
    if (uri !== 'quote://codes') throw new Error(`演示模式不支持资源 ${uri}`);
    return UNIVERSE.map(({ code, label }) => ({ code, name: label })) as T;
  }

  async callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const tool = name as Jin10Tool;
    switch (tool) {
      case 'get_quote':
        return quoteOf(String(args.code ?? 'XAUUSD')) as T;
      case 'get_kline':
        return klineOf(String(args.code ?? 'XAUUSD'), Number(args.count ?? 100)) as T;
      case 'list_flash':
        return page(flashes()) as T;
      case 'search_flash':
        return page(filterFlash(String(args.keyword ?? ''))) as T;
      case 'list_news':
        return page(NEWS) as T;
      case 'search_news':
        return page(filterNews(String(args.keyword ?? ''))) as T;
      case 'get_news':
        return detailOf(String(args.id ?? 'demo-1')) as T;
      case 'list_calendar':
        return calendar() as T;
      default:
        throw new Error(`演示模式不支持工具 ${name}`);
    }
  }
}

function quoteOf(rawCode: string): Quote {
  const code = rawCode.toUpperCase();
  const instrument = UNIVERSE.find((item) => item.code === code);
  const base = BASE_PRICE[code] ?? 100 + (hash(code) % 900);
  const seed = hash(code);
  const slot = Math.floor(Date.now() / 5_000);
  const open = base * (1 + Math.sin(seed * 0.17) * 0.002);
  const change = Math.sin(slot * 0.08 + seed) * 0.004 + Math.cos(slot * 0.031 + seed * 0.3) * 0.0015;
  const close = open * (1 + change);
  const high = Math.max(open, close) * (1 + 0.0025);
  const low = Math.min(open, close) * (1 - 0.0022);
  const digits = decimals(base);
  return {
    code,
    name: instrument?.label ?? code,
    time: new Date().toISOString(),
    open: open.toFixed(digits),
    close: close.toFixed(digits),
    high: high.toFixed(digits),
    low: low.toFixed(digits),
    volume: 18_000 + (seed % 82_000),
    ups_price: (close - open).toFixed(digits),
    ups_percent: (change * 100).toFixed(2),
  };
}

function klineOf(rawCode: string, requested: number): KlineSeries {
  const code = rawCode.toUpperCase();
  const count = Math.min(100, Math.max(1, Math.trunc(requested) || 100));
  const instrument = UNIVERSE.find((item) => item.code === code);
  const base = BASE_PRICE[code] ?? 100 + (hash(code) % 900);
  const digits = decimals(base);
  const nowMinute = Math.floor(Date.now() / 60_000) * 60;
  const klines: KlineBar[] = [];

  for (let i = count - 1; i >= 0; i--) {
    const point = count - i;
    const center = base * (1 + Math.sin((point + hash(code)) * 0.19) * 0.005 + point * 0.000012);
    const open = center * (1 + Math.sin(point * 0.71) * 0.0007);
    const close = center * (1 + Math.cos(point * 0.53) * 0.0008);
    klines.push({
      time: nowMinute - i * 60,
      open: open.toFixed(digits),
      close: close.toFixed(digits),
      high: (Math.max(open, close) * 1.0008).toFixed(digits),
      low: (Math.min(open, close) * 0.9992).toFixed(digits),
      volume: 180 + ((point * 97 + hash(code)) % 2_400),
    });
  }

  return { code, name: instrument?.label ?? code, klines };
}

function flashes(): FlashItem[] {
  return FLASH_TEXT.map((content, index) => ({
    id: `demo-flash-${index + 1}`,
    content,
    time: new Date(Date.now() - index * 6 * 60_000).toISOString(),
    url: '',
  }));
}

function filterFlash(keyword: string): FlashItem[] {
  const all = flashes();
  const q = keyword.trim().toLowerCase();
  if (!q) return all;
  const hits = all.filter((item) => item.content.toLowerCase().includes(q));
  return hits.length ? hits : all.slice(0, 3);
}

function filterNews(keyword: string): NewsItem[] {
  const q = keyword.trim().toLowerCase();
  if (!q) return NEWS;
  const hits = NEWS.filter((item) => `${item.title}${item.introduction}`.toLowerCase().includes(q));
  return hits.length ? hits : NEWS.slice(0, 2);
}

function detailOf(id: string): NewsDetail {
  const item = NEWS.find((entry) => entry.id === id) ?? NEWS[0]!;
  return {
    ...item,
    content:
      `${item.introduction}\n\n` +
      '这是一段由项目内置演示数据生成的正文，用于验证详情弹层、排版、主题与响应式布局。\n\n' +
      '演示模式不会连接金十或智堡，也不代表任何真实市场观点。',
  };
}

function calendar(): CalendarEvent[] {
  const offsets = [-150, -35, 45, 110, 230, 410];
  const titles = ['中国工业企业利润年率', '欧元区消费者信心指数', '美国耐用品订单月率', '美国消费者信心指数', '日本央行会议摘要', '美国原油库存'];
  return offsets.map((minutes, index) => ({
    pub_time: bjDateTime(Date.now() + minutes * 60_000),
    star: [2, 2, 3, 3, 4, 3][index] ?? 2,
    title: titles[index]!,
    previous: ['3.2', '-14.7', '1.8', '96.8', null, '-3.9'][index] ?? null,
    consensus: ['3.5', '-14.2', '0.8', '97.1', null, '-1.2'][index] ?? null,
    actual: minutes < 0 ? (['3.7', '-13.9'][index] ?? null) : null,
    revised: null,
    affect_txt: minutes < 0 ? (index % 2 === 0 ? '利多' : '利空') : '',
  }));
}

function bjDateTime(ms: number): string {
  const date = new Date(ms + 8 * 60 * 60 * 1_000);
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`;
}

function page<T>(items: T[]): Paged<T> {
  return { items, next_cursor: null, has_more: false };
}

function hash(value: string): number {
  let out = 0;
  for (const char of value) out = (out * 31 + char.charCodeAt(0)) >>> 0;
  return out;
}

function decimals(value: number): number {
  if (value < 2) return 4;
  if (value < 100) return 3;
  if (value < 10_000) return 2;
  return 0;
}
