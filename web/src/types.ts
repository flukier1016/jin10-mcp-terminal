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
  time: number;
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

export interface ToolQuota {
  tool: string;
  used: number;
  limit: number;
  remaining: number;
  spendable: number;
  intervalMs: number;
}

export interface QuotaSnapshot {
  day: string;
  resetInMs: number;
  tools: ToolQuota[];
}

export interface Paged<T> {
  items: T[];
  next_cursor: string | number | null;
  has_more: boolean;
}

export type ConnState = 'connecting' | 'live' | 'down';
