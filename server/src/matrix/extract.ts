import { TOPICS, extractCompanies } from '../core/topics.js';

export interface MatrixTag {
  dimension: 'topic' | 'group' | 'company' | 'stance' | 'horizon' | 'region';
  value: string;
  score: number;
}

export interface MatrixAnalysis {
  conclusion: string;
  tags: MatrixTag[];
}

const CONCLUSION_HEADINGS = [
  '陈述总结',
  '结论',
  '核心结论',
  '投资结论',
  '评级与目标价',
  '核心观点',
  '投资要点',
  '主要观点',
  '摘要',
  'summary',
  'conclusion',
  'key takeaways',
] as const;

const STANCE_WORDS = {
  bullish: ['买入', '增持', '超配', '看多', '上调', '利好', '强劲', '改善', '上行', '突破', '增长', '受益', '乐观'],
  bearish: ['卖出', '减持', '低配', '看空', '下调', '利空', '疲弱', '恶化', '下行', '衰退', '收缩', '承压', '悲观'],
} as const;

const REGIONS: Array<[string, string[]]> = [
  ['中国', ['中国', '国内', 'A股', '人民币', '中国央行', '港股', '香港']],
  ['美国', ['美国', '美联储', '美股', '美债', '美元', '华尔街']],
  ['欧洲', ['欧洲', '欧元区', '欧洲央行', '欧元', '英国', '英镑']],
  ['日本', ['日本', '日股', '日经', '日本央行', '日元']],
  ['亚太', ['亚太', '亚洲', '韩国', '澳大利亚', '印度', '东南亚']],
  ['全球', ['全球', '世界经济', '跨资产']],
];

/** 从智堡正文中抽取可追溯的结论与结构化维度，不凭空生成观点。 */
export function analyzeResearch(title: string, summary = '', content = ''): MatrixAnalysis {
  const conclusion = extractConclusion(summary, content);
  const haystack = `${title}\n${summary}\n${conclusion}\n${content.slice(0, 12_000)}`;
  const tags: MatrixTag[] = [];

  for (const topic of TOPICS) {
    const hits = topicHits(topic.key, topic.keywords, haystack);
    if (!hits) continue;
    tags.push({ dimension: 'topic', value: topic.label, score: Math.min(1, 0.55 + hits * 0.2) });
    tags.push({ dimension: 'group', value: topic.group, score: Math.min(1, 0.5 + hits * 0.15) });
  }

  for (const company of extractCompanies(title)) {
    tags.push({ dimension: 'company', value: company, score: 0.95 });
  }

  const stance = inferStance(`${title}\n${conclusion}`);
  tags.push({ dimension: 'stance', value: stance, score: stance === '中性' ? 0.5 : 0.78 });

  const horizon = inferHorizon(haystack);
  tags.push({ dimension: 'horizon', value: horizon, score: 0.65 });

  for (const [region, keywords] of REGIONS) {
    const hits = keywords.filter((keyword) => includesFold(haystack, keyword)).length;
    if (hits) tags.push({ dimension: 'region', value: region, score: Math.min(1, 0.5 + hits * 0.12) });
  }

  return { conclusion, tags: dedupeTags(tags) };
}

export function extractConclusion(summary: string, content: string): string {
  for (const heading of CONCLUSION_HEADINGS) {
    const escaped = escapeRegex(heading);
    const markdown = new RegExp(
      `(?:^|\\n)#{1,4}\\s*[^\\n]*${escaped}[^\\n]*\\n([\\s\\S]*?)(?=\\n#{1,4}\\s|$)`,
      'i',
    ).exec(content)?.[1];
    const cleanMarkdown = cleanText(markdown ?? '');
    if (cleanMarkdown.length >= 18) return truncate(cleanMarkdown, 1_200);

    const plain = new RegExp(
      `(?:^|\\n)\\s*(?:${escaped})\\s*[：:]?\\s*\\n([\\s\\S]*?)(?=\\n\\s*[^\\n]{1,24}[：:]\\s*\\n|$)`,
      'i',
    ).exec(content)?.[1];
    const cleanPlain = cleanText(plain ?? '');
    if (cleanPlain.length >= 18) return truncate(cleanPlain, 1_200);
  }

  const cleanedSummary = cleanText(summary);
  if (cleanedSummary.length >= 18) return truncate(cleanedSummary, 1_200);

  const paragraphs = cleanText(content)
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 24 && !/^事实依据/.test(part));
  const best = paragraphs
    .slice(0, 6)
    .sort((a, b) => conclusionScore(b) - conclusionScore(a))
    .slice(0, 3)
    .join('\n');
  return truncate(best || cleanText(content), 1_200);
}

export function cleanResearchText(raw: string): string {
  return cleanText(raw);
}

function inferStance(text: string): '偏多' | '偏空' | '中性' | '分歧' {
  const bullish = countTerms(text, STANCE_WORDS.bullish);
  const bearish = countTerms(text, STANCE_WORDS.bearish);
  if (bullish && bearish && Math.abs(bullish - bearish) <= 1) return '分歧';
  if (bullish > bearish) return '偏多';
  if (bearish > bullish) return '偏空';
  return '中性';
}

function inferHorizon(text: string): '短期' | '中期' | '长期' | '未注明' {
  if (/(未来\s*(?:3|5|10)\s*年|长期|结构性|多年|战略周期)/i.test(text)) return '长期';
  if (/(未来\s*(?:6|12|18)\s*个?月|中期|明年|全年|年度)/i.test(text)) return '中期';
  if (/(短期|近期|本周|本月|未来\s*(?:1|2|3)\s*个?月|战术)/i.test(text)) return '短期';
  return '未注明';
}

function conclusionScore(value: string): number {
  const lengthScore = Math.min(value.length, 800);
  const signalScore = countTerms(value, [...STANCE_WORDS.bullish, ...STANCE_WORDS.bearish]) * 80;
  const numberScore = Math.min((value.match(/\d+(?:\.\d+)?%?/g) ?? []).length, 8) * 15;
  return lengthScore + signalScore + numberScore;
}

function cleanText(raw: string): string {
  return raw
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countTerms(text: string, terms: readonly string[]): number {
  return terms.reduce((sum, term) => sum + (includesFold(text, term) ? 1 : 0), 0);
}

function includesFold(text: string, term: string): boolean {
  return text.toLocaleLowerCase().includes(term.toLocaleLowerCase());
}

function topicHits(key: string, keywords: string[], text: string): number {
  // “目标价108美元”是计价单位，不应把所有美股公司报告都归到美元交易主题。
  if (key === 'usd') {
    return /(美元(?:指数|汇率|周期|资产|流动性|走强|走弱|升值|贬值|兑)|DXY|USD(?:CNH|JPY|CHF|CAD|Index))/i.test(
      text,
    )
      ? 1
      : 0;
  }
  return keywords.filter((keyword) => includesFold(text, keyword)).length;
}

function dedupeTags(tags: MatrixTag[]): MatrixTag[] {
  const out = new Map<string, MatrixTag>();
  for (const tag of tags) {
    const key = `${tag.dimension}:${tag.value}`;
    const current = out.get(key);
    if (!current || tag.score > current.score) out.set(key, tag);
  }
  return [...out.values()];
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const sliced = value.slice(0, max);
  const boundary = Math.max(sliced.lastIndexOf('。'), sliced.lastIndexOf('\n'));
  return `${sliced.slice(0, boundary > max * 0.55 ? boundary + 1 : max).trim()}…`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
