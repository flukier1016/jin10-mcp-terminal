/** 金十数据 MCP 返回的领域模型 —— 全部以 result.structuredContent.data 为准。 */

export interface Quote {
  code: string;
  name: string;
  time: string;
  open: string;
  close: string;
  high: string;
  low: string;
  volume: number;
  ups_price: string;
  ups_percent: string;
}

export interface KlineBar {
  time: number; // Unix 秒
  open: string;
  high: string;
  low: string;
  close: string;
  volume: number;
}

export interface KlineSeries {
  code: string;
  name: string;
  klines: KlineBar[];
}

export interface FlashItem {
  content: string;
  time: string;
  url: string;
  /** 官方文档示例里有 id/title，但线上实际返回不含这两项 —— 按可选处理。 */
  id?: string;
  title?: string;
}

export interface NewsItem {
  id: string;
  title: string;
  introduction: string;
  time: string;
  url: string;
}

export interface NewsDetail extends NewsItem {
  content: string;
}

export interface CalendarEvent {
  pub_time: string;
  star: number;
  title: string;
  previous: string | null;
  consensus: string | null;
  actual: string | null;
  revised: string | null;
  affect_txt: string;
}

export interface QuoteCode {
  code: string;
  name: string;
}

/** 所有列表工具的统一分页信封。 */
export interface Paged<T> {
  items: T[];
  next_cursor: string | number | null;
  has_more: boolean;
}

/** 服务端推给前端的 SSE 事件。 */
export type StreamEvent =
  | { type: 'hello'; serverTime: number; quota: QuotaSnapshot; codes: QuoteCode[] }
  | { type: 'quote'; quote: Quote; at: number }
  | { type: 'kline'; code: string; name: string; bars: KlineBar[]; at: number }
  | { type: 'flash'; items: FlashItem[]; at: number }
  | { type: 'news'; items: NewsItem[]; at: number }
  | { type: 'calendar'; events: CalendarEvent[]; at: number }
  | { type: 'quota'; quota: QuotaSnapshot }
  | { type: 'status'; mcp: 'up' | 'down' | 'connecting'; detail?: string }
  | { type: 'ping'; at: number };

export interface ToolQuota {
  tool: string;
  used: number;
  limit: number;
  remaining: number;
  spendable: number;
  intervalMs: number;
}

export interface QuotaSnapshot {
  /** 北京时间自然日，YYYY-MM-DD */
  day: string;
  resetInMs: number;
  tools: ToolQuota[];
}
