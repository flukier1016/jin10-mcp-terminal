import { McpClient, McpRateLimitError } from './client.js';
import type { QuotaLedger } from '../core/quota.js';
import type {
  CalendarEvent,
  FlashItem,
  KlineSeries,
  NewsDetail,
  NewsItem,
  Paged,
  Quote,
  QuoteCode,
} from '../types.js';

/** 金十已验证可用的 8 个工具。 */
export const TOOLS = [
  'get_quote',
  'get_kline',
  'list_flash',
  'search_flash',
  'list_news',
  'search_news',
  'get_news',
  'list_calendar',
] as const;

export type Jin10Tool = (typeof TOOLS)[number];

/**
 * 金十数据的类型化门面。
 *
 * 每次 tools/call 都先过额度账本：本地额度耗尽直接拒绝（不浪费一次真实调用），
 * 服务端回限流则把该工具封到次日北京时间零点。
 */
export class Jin10Service {
  constructor(
    private readonly mcp: McpClient,
    private readonly ledger: QuotaLedger,
  ) {}

  private async call<T>(tool: Jin10Tool, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.ledger.canSpend(tool)) {
      throw new McpRateLimitError(tool, `本地额度保护：今日 ${tool} 剩余调用次数不足，明日北京时间零点重置`);
    }
    this.ledger.record(tool);
    try {
      return await this.mcp.callTool<T>(tool, args);
    } catch (err) {
      if (err instanceof McpRateLimitError) this.ledger.markExhausted(tool);
      throw err;
    }
  }

  /** 资源读取不计入工具限流。 */
  async quoteCodes(): Promise<QuoteCode[]> {
    return this.mcp.readResource<QuoteCode[]>('quote://codes');
  }

  getQuote(code: string): Promise<Quote> {
    return this.call<Quote>('get_quote', { code });
  }

  /** K 线原始返回是时间倒序，这里统一转成升序方便直接喂图表。 */
  async getKline(code: string, opts: { time?: number; count?: number } = {}): Promise<KlineSeries> {
    const args: Record<string, unknown> = { code };
    if (opts.time !== undefined) args.time = opts.time;
    if (opts.count !== undefined) args.count = Math.min(100, Math.max(1, Math.trunc(opts.count)));
    const series = await this.call<KlineSeries>('get_kline', args);
    const klines = [...(series.klines ?? [])].sort((a, b) => a.time - b.time);
    return { ...series, klines };
  }

  listFlash(cursor?: string): Promise<Paged<FlashItem>> {
    return this.call<Paged<FlashItem>>('list_flash', cursor ? { cursor } : {});
  }

  /** search_flash 最多 150 条且不支持翻页，服务端不返回分页字段时补齐。 */
  async searchFlash(keyword: string): Promise<Paged<FlashItem>> {
    const data = await this.call<Paged<FlashItem> | FlashItem[]>('search_flash', { keyword });
    if (Array.isArray(data)) return { items: data, next_cursor: null, has_more: false };
    return { items: data.items ?? [], next_cursor: data.next_cursor ?? null, has_more: data.has_more ?? false };
  }

  listNews(cursor?: string): Promise<Paged<NewsItem>> {
    return this.call<Paged<NewsItem>>('list_news', cursor ? { cursor } : {});
  }

  searchNews(keyword: string, cursor?: string): Promise<Paged<NewsItem>> {
    return this.call<Paged<NewsItem>>('search_news', cursor ? { keyword, cursor } : { keyword });
  }

  getNews(id: string): Promise<NewsDetail> {
    return this.call<NewsDetail>('get_news', { id });
  }

  listCalendar(): Promise<CalendarEvent[]> {
    return this.call<CalendarEvent[]>('list_calendar', {});
  }
}
