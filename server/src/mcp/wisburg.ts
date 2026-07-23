import { McpClient, McpRateLimitError, McpToolError } from './client.js';
import type { QuotaLedger } from '../core/quota.js';

/**
 * 智堡 Wisburg MCP 门面。
 *
 * 与金十的关键差异：**智堡不返回 structuredContent**，只给 content[0].text
 * （人读的 markdown）。所以这一路必须做文本解析，而不是直接取 data 字段。
 * 分页约定也不同：请求用 first/after，响应把游标写在 "Next cursor: N" 那一行。
 */

export const WISBURG_TOOLS = [
  'list-institutional-reports',
  'list-company-reports',
  'list-am-reports',
  'list-archive-reports',
  'list-earning-calls',
  'get-report-detail',
  'list-feed',
  'list-market-daily',
  'list-images',
  'list-articles',
  'get-article-detail',
] as const;

export type WisburgTool = (typeof WISBURG_TOOLS)[number];

/** 研报分类 —— get-report-detail 的 category 必须与列表来源一致。 */
export type ReportCategory = 'ib' | 'company' | 'am' | 'archive' | 'ec';

export const CATEGORY_TOOL: Record<ReportCategory, WisburgTool> = {
  ib: 'list-institutional-reports',
  company: 'list-company-reports',
  am: 'list-am-reports',
  archive: 'list-archive-reports',
  ec: 'list-earning-calls',
};

export const CATEGORY_LABEL: Record<ReportCategory, string> = {
  ib: '投行研报',
  company: '企业研究',
  am: '资管报告',
  archive: '公开文献',
  ec: '电话会纪要',
};

export interface WisburgItem {
  id: string;
  title: string;
  time: string;
  summary?: string;
  image?: string;
  category?: ReportCategory | 'feed' | 'daily' | 'article' | 'image';
}

export interface WisburgPage {
  items: WisburgItem[];
  next_cursor: string | null;
  has_more: boolean;
  total?: number;
}

export interface WisburgDetail {
  id: string;
  title: string;
  time: string;
  /** 正文（markdown）。 */
  content: string;
  url?: string;
  fields: Record<string, string>;
}

export interface ListArgs {
  first?: number;
  after?: string;
  query?: string;
  startTime?: string;
  endTime?: string;
}

export class WisburgService {
  constructor(
    private readonly mcp: McpClient,
    private readonly ledger: QuotaLedger,
  ) {}

  /** 智堡工具返回纯文本，这里拿原始文本而不是 structuredContent。 */
  private async callText(tool: WisburgTool, args: Record<string, unknown>): Promise<string> {
    if (!this.ledger.canSpend(tool)) {
      throw new McpRateLimitError(tool, `本地额度保护：今日 ${tool} 剩余调用次数不足`);
    }
    this.ledger.record(tool);

    const res = await this.mcp.callToolRaw(tool, args);
    const text = (res.content ?? [])
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('\n')
      .trim();

    if (res.isError) {
      throw text.includes('上限') || text.includes('limit')
        ? new McpRateLimitError(tool, text || '调用受限')
        : new McpToolError(tool, text || '工具返回错误');
    }
    if (!text) throw new McpToolError(tool, '响应为空');
    return text;
  }

  private clean(args: ListArgs): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (args.first !== undefined) out.first = Math.min(100, Math.max(1, Math.trunc(args.first)));
    if (args.after) out.after = args.after;
    if (args.query) out.query = args.query;
    if (args.startTime) out.startTime = args.startTime;
    if (args.endTime) out.endTime = args.endTime;
    return out;
  }

  async listReports(category: ReportCategory, args: ListArgs = {}): Promise<WisburgPage> {
    const text = await this.callText(CATEGORY_TOOL[category], this.clean(args));
    const page = parseList(text);
    return { ...page, items: page.items.map((i) => ({ ...i, category })) };
  }

  async listFeed(args: ListArgs = {}): Promise<WisburgPage> {
    const text = await this.callText('list-feed', this.clean(args));
    const page = parseList(text);
    return { ...page, items: page.items.map((i) => ({ ...i, category: 'feed' as const })) };
  }

  async listMarketDaily(args: ListArgs = {}): Promise<WisburgPage> {
    const text = await this.callText('list-market-daily', this.clean(args));
    const page = parseList(text);
    return { ...page, items: page.items.map((i) => ({ ...i, category: 'daily' as const })) };
  }

  async listArticles(args: ListArgs = {}): Promise<WisburgPage> {
    const text = await this.callText('list-articles', this.clean(args));
    const page = parseList(text);
    return { ...page, items: page.items.map((i) => ({ ...i, category: 'article' as const })) };
  }

  async listImages(args: ListArgs = {}): Promise<WisburgPage> {
    const text = await this.callText('list-images', this.clean(args));
    return parseImages(text);
  }

  async getReport(id: string, category: ReportCategory): Promise<WisburgDetail> {
    const text = await this.callText('get-report-detail', { id: Number(id), category });
    return parseDetail(text, id);
  }

  async getArticle(id: string): Promise<WisburgDetail> {
    const text = await this.callText('get-article-detail', { id: Number(id) });
    return parseDetail(text, id);
  }
}

// ── 文本解析 ────────────────────────────────────────────────────
//
// 列表格式：
//   Found N xxx:
//
//   [97090] 标题
//     date: 2026-07-23T12:34:56+08:00
//     摘要（可跨多行，markdown）
//
//   --- Page Info ---
//   Next cursor: 2

const CURSOR_RE = /Next cursor:\s*(\S+)/i;
const TOTAL_RE = /Found\s+(\d+)/i;

export function parseList(text: string): WisburgPage {
  const cursor = CURSOR_RE.exec(text)?.[1] ?? null;
  const total = Number(TOTAL_RE.exec(text)?.[1] ?? NaN);
  const body = text.split(/---\s*Page Info\s*---/i)[0] ?? text;

  const items: WisburgItem[] = [];
  // 以 "[id] 标题" 开头切块，块内首个 date: 行是时间，其余非 key 行拼成摘要
  const blocks = body.split(/\n(?=\[\d+\]\s)/);
  for (const block of blocks) {
    const head = /^\[(\d+)\]\s*(.*)$/m.exec(block);
    if (!head) continue;
    const id = head[1]!;
    const title = head[2]!.trim();
    const time = /^\s*date:\s*(\S+)/m.exec(block)?.[1] ?? '';

    const summary = block
      .split(/\n/)
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l && !/^(date|image|url|id):/i.test(l))
      .join('\n')
      .trim();

    items.push({ id, title, time, ...(summary ? { summary } : {}) });
  }

  return {
    items,
    next_cursor: cursor,
    has_more: cursor !== null && items.length > 0,
    ...(Number.isFinite(total) ? { total } : {}),
  };
}

/**
 * 图表列表没有 [id] 前缀，格式是：
 *   title: XXX
 *     date: ISO
 *     image: URL
 *     描述
 */
export function parseImages(text: string): WisburgPage {
  const cursor = CURSOR_RE.exec(text)?.[1] ?? null;
  const body = text.split(/---\s*Page Info\s*---/i)[0] ?? text;

  const items: WisburgItem[] = [];
  const blocks = body.split(/\n(?=title:\s)/);
  for (const [idx, block] of blocks.entries()) {
    const title = /^title:\s*(.*)$/m.exec(block)?.[1]?.trim();
    if (!title) continue;
    const time = /^\s*date:\s*(\S+)/m.exec(block)?.[1] ?? '';
    const image = /^\s*image:\s*(\S+)/m.exec(block)?.[1] ?? '';
    const summary = block
      .split(/\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^(title|date|image|url|id):/i.test(l))
      .join('\n')
      .trim();

    items.push({
      // 图表没有 id，用 URL 或序号兜底，前端只拿它当 React key
      id: image || `img-${idx}`,
      title,
      time,
      category: 'image',
      ...(image ? { image } : {}),
      ...(summary ? { summary } : {}),
    });
  }

  return { items, next_cursor: cursor, has_more: cursor !== null && items.length > 0 };
}

/**
 * 详情格式：
 *   # 标题
 *
 *   - ID: 97090
 *   - Date: 2026-07-23T...
 *
 *   ## Summary   (或 ## Content)
 *   <正文>
 */
export function parseDetail(text: string, fallbackId: string): WisburgDetail {
  const title = /^#\s+(.*)$/m.exec(text)?.[1]?.trim() ?? '';

  const fields: Record<string, string> = {};
  for (const m of text.matchAll(/^-\s*([A-Za-z ]+):\s*(.+)$/gm)) {
    fields[m[1]!.trim().toLowerCase()] = m[2]!.trim();
  }

  // 正文从第一个二级标题（## Summary / ## Content / ## …）之后开始
  const split = /^##\s+.*$/m.exec(text);
  const content = split?.index !== undefined ? text.slice(split.index + split[0].length).trim() : text.trim();

  return {
    id: fields.id ?? fallbackId,
    title,
    time: fields.date ?? '',
    content,
    ...(fields.url ? { url: fields.url } : {}),
    fields,
  };
}
