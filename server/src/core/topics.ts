/**
 * 主题（品种）与公司两个维度的分面。
 *
 * 智堡的 MCP 只提供关键词搜索，没有分类 facet；金十同理。
 * 所以这里用「关键词 → 多源并发搜索 → 合并时间线」的方式自己造分面，
 * 并把主题映射到可交易的行情代码，让研究和报价能对上。
 */

export type TopicGroup = 'commodity' | 'fx' | 'rates' | 'equity' | 'macro';

export interface Topic {
  key: string;
  label: string;
  group: TopicGroup;
  /** 搜索关键词，第一个作为主词发给各数据源。 */
  keywords: string[];
  /** 对应的金十行情代码，有则在主题页顶部展示实时报价。 */
  code?: string;
}

export const TOPIC_GROUP_LABEL: Record<TopicGroup, string> = {
  commodity: '大宗商品',
  fx: '外汇',
  rates: '利率与央行',
  equity: '股票市场',
  macro: '宏观主题',
};

export const TOPICS: Topic[] = [
  // 大宗商品
  { key: 'gold', label: '黄金', group: 'commodity', code: 'XAUUSD', keywords: ['黄金', '金价'] },
  { key: 'silver', label: '白银', group: 'commodity', code: 'XAGUSD', keywords: ['白银'] },
  { key: 'oil', label: '原油', group: 'commodity', code: 'USOIL', keywords: ['原油', '油价', '欧佩克'] },
  { key: 'gas', label: '天然气', group: 'commodity', code: 'NGAS', keywords: ['天然气'] },
  { key: 'copper', label: '铜', group: 'commodity', code: 'COPPER', keywords: ['铜价', '铜'] },

  // 外汇
  { key: 'usd', label: '美元', group: 'fx', keywords: ['美元', '美元指数'] },
  { key: 'eur', label: '欧元', group: 'fx', code: 'EURUSD', keywords: ['欧元'] },
  { key: 'jpy', label: '日元', group: 'fx', code: 'USDJPY', keywords: ['日元'] },
  { key: 'cny', label: '人民币', group: 'fx', code: 'USDCNH', keywords: ['人民币', '离岸人民币'] },
  { key: 'gbp', label: '英镑', group: 'fx', code: 'GBPUSD', keywords: ['英镑'] },

  // 利率与央行
  { key: 'fed', label: '美联储', group: 'rates', keywords: ['美联储', 'FOMC', '鲍威尔'] },
  { key: 'ecb', label: '欧洲央行', group: 'rates', keywords: ['欧洲央行', 'ECB'] },
  { key: 'boj', label: '日本央行', group: 'rates', keywords: ['日本央行'] },
  { key: 'pboc', label: '中国央行', group: 'rates', keywords: ['央行', 'LPR', 'MLF'] },
  { key: 'ust', label: '美债', group: 'rates', keywords: ['美债', '国债收益率'] },

  // 股票市场
  { key: 'ashare', label: 'A股', group: 'equity', code: '000001', keywords: ['A股', '上证'] },
  { key: 'hk', label: '港股', group: 'equity', code: 'HSI', keywords: ['港股', '恒生'] },
  { key: 'us', label: '美股', group: 'equity', code: 'SPX', keywords: ['美股', '标普'] },
  { key: 'jp', label: '日股', group: 'equity', code: 'N225', keywords: ['日经', '日股'] },

  // 宏观主题
  { key: 'inflation', label: '通胀', group: 'macro', keywords: ['通胀', 'CPI'] },
  { key: 'jobs', label: '就业', group: 'macro', keywords: ['非农', '就业'] },
  { key: 'tariff', label: '关税', group: 'macro', keywords: ['关税', '贸易'] },
  { key: 'geo', label: '地缘', group: 'macro', keywords: ['地缘', '中东'] },
  { key: 'ai', label: 'AI 算力', group: 'macro', keywords: ['AI', '算力', '半导体'] },
];

export const TOPIC_BY_KEY = new Map(TOPICS.map((t) => [t.key, t]));

// ── 公司抽取 ────────────────────────────────────────────────────

/**
 * 常见公司词典。
 *
 * 词典 + 结构化模式双管齐下：公司名在标题里位置很随意
 * （「Alphabet云加速但…」「英伟达与AMD的…」「下调滔搏和宝胜…」），
 * 只靠位置模式召回率太低。
 */
const COMPANY_DICT: string[] = [
  // 美股科技
  '英伟达', 'NVIDIA', 'AMD', '英特尔', 'Intel', '苹果', 'Apple', '微软', 'Microsoft',
  '谷歌', 'Alphabet', '亚马逊', 'Amazon', 'Meta', '特斯拉', 'Tesla', 'Netflix', 'Arm',
  '博通', 'Broadcom', '甲骨文', 'Oracle', 'Salesforce', 'Palantir', 'Roblox', 'Uber',
  'SpaceX', 'OpenAI', 'Anthropic', 'Coinbase', 'Snowflake', 'Dell', 'HPE', 'Cisco',
  // 半导体供应链
  '台积电', 'TSMC', '三星', 'Samsung', 'SK海力士', '美光', 'Micron', 'ASML', '阿斯麦',
  '应用材料', '中芯国际', '海光信息', '寒武纪',
  // 消费
  '耐克', 'Nike', 'Lululemon', '阿迪达斯', '星巴克', 'Starbucks', '麦当劳',
  '安踏体育', '安踏', '李宁', '滔搏', '宝胜', '茅台', '五粮液', '农夫山泉', '蜜雪冰城',
  '菲利普莫里斯', '宝洁', '联合利华',
  // 医药生物
  '康方生物', '三生制药', '百济神州', '恒瑞医药', '药明康德', '药明生物', '信达生物',
  '礼来', 'Eli Lilly', '诺和诺德', 'Novo Nordisk', '辉瑞', 'Pfizer', '默沙东',
  // 金融
  '摩根士丹利', '高盛', 'Goldman', '摩根大通', 'JPMorgan', '花旗', '汇丰', '瑞银', 'UBS',
  '巴克莱', 'Barclays', '野村', 'Nomura', '伯克希尔', 'Stifel',
  // 工业能源
  'GE Vernova', 'Wabtec', '西屋制动', 'TE Connectivity', 'Teledyne', 'Range Resources',
  'RPM International', '普尔特', '卡特彼勒', '波音', 'Boeing', '空客', 'Airbus',
  '埃克森美孚', '雪佛龙', '壳牌', 'Shell', 'BP', '道达尔',
  '杰瑞股份', '宁德时代', '比亚迪', '隆基绿能', '阳光电源',
  // 平台互联网
  '腾讯', '阿里巴巴', '阿里', '美团', '京东', '拼多多', '字节跳动', '小米', '华为',
  '百度', 'networks', '网易', '快手', '理想汽车', '小鹏汽车', '蔚来', '月之暗面',
];

/** 明显不是公司的前缀词，避免「数据中心：」「减持解析：」被当成公司。 */
const NOT_COMPANY = new Set([
  '数据中心', '减持解析', '锂', '首次覆盖给予持有评级', '中国食品饮料', '亚太电力设备',
  '云资本支出综述', '业务成本', '中国重卡行业', '可持续投资现状', 'ETF指南',
  '新兴市场债务入门', '海湾航运追踪与全球响应', '亚洲暑期学校', '松泽晨会报告',
  '野村科技月报', '亚洲绿色能源竞赛', '摘要', '要点', '观点', '总结', '前瞻', '综述',
  '市场', '行业', '策略', '宏观', '专题', '深度', '快评', '点评',
]);

const DICT_SORTED = [...COMPANY_DICT].sort((a, b) => b.length - a.length);

/**
 * 从标题里抽取公司名。
 *
 * 三条路子并用：
 *  1. 词典命中（覆盖标题中段出现的情况，召回主力）
 *  2. 电话会格式「公司名 + 2026年第二季度…」→ 取年份前的部分
 *  3. 冒号前缀「安踏体育：…」→ 短前缀且不在停用词表里才算
 */
export function extractCompanies(title: string): string[] {
  const found = new Set<string>();

  for (const name of DICT_SORTED) {
    if (title.includes(name)) found.add(normalizeCompany(name));
  }

  // 电话会 / 财报格式
  const call = /^(.{2,24}?)\s*(?:20\d{2})\s*(?:年|财年)/.exec(title);
  if (call?.[1]) {
    const c = cleanCandidate(call[1]);
    if (c) found.add(c);
  }

  // 冒号前缀
  const prefix = /^([^：:]{2,14})[：:]/.exec(title);
  if (prefix?.[1]) {
    const c = cleanCandidate(prefix[1]);
    if (c) found.add(c);
  }

  return [...found];
}

/** 「西屋制动（Wabtec）」这类中英并列统一取中文主名。 */
function normalizeCompany(name: string): string {
  return name.trim();
}

function cleanCandidate(raw: string): string | null {
  // 去掉括号里的英文别名、破折号后缀，以及首尾标点
  // （电话会标题「America Movil：2026年第二季度…」会把冒号一起捕获进来）
  const s = raw
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[-—–].*$/, '')
    .replace(/^[\s：:，,、.。·|/-]+|[\s：:，,、.。·|/-]+$/g, '')
    .trim();
  if (!s || s.length < 2 || s.length > 14) return null;
  if (NOT_COMPANY.has(s)) return null;
  // 纯行业词/纯数字不算公司
  if (/^[\d\s%.]+$/.test(s)) return null;
  if (/(行业|市场|板块|指数|策略|综述|前瞻|解读|纪要|报告|展望|月报|周报|晨会)$/.test(s)) return null;
  return s;
}

export interface CompanyFacet {
  name: string;
  count: number;
  /** 命中该公司的报告 id 与来源分类 */
  refs: Array<{ id: string; title: string; time: string; category: string }>;
}

/** 把一批报告聚合成公司分面，按出现次数降序。 */
export function buildCompanyFacets(
  items: Array<{ id: string; title: string; time: string; category?: string }>,
): CompanyFacet[] {
  const map = new Map<string, CompanyFacet>();
  for (const it of items) {
    for (const name of extractCompanies(it.title)) {
      const f = map.get(name) ?? { name, count: 0, refs: [] };
      f.count++;
      f.refs.push({ id: it.id, title: it.title, time: it.time, category: it.category ?? 'company' });
      map.set(name, f);
    }
  }
  return mergeAliases([...map.values()]).sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
}

/**
 * 合并同一家公司的长短写法：词典给「Stifel」，电话会标题给「Stifel Financial」。
 * 短名是长名前缀时并入长名，引用去重后重算计数。
 */
function mergeAliases(facets: CompanyFacet[]): CompanyFacet[] {
  const byLength = [...facets].sort((a, b) => b.name.length - a.name.length);
  const kept: CompanyFacet[] = [];

  for (const f of byLength) {
    const host = kept.find((k) => {
      const a = k.name.toLowerCase();
      const b = f.name.toLowerCase();
      // 中文 2 字已是完整公司名（安踏 → 安踏体育），拉丁字母要 3 位以上才敢合并
      const min = /[一-鿿]/.test(b) ? 2 : 3;
      return a !== b && a.startsWith(b) && b.length >= min;
    });
    if (!host) {
      kept.push(f);
      continue;
    }
    for (const r of f.refs) if (!host.refs.some((x) => x.id === r.id)) host.refs.push(r);
    host.count = host.refs.length;
  }

  for (const k of kept) k.count = k.refs.length;
  return kept;
}
