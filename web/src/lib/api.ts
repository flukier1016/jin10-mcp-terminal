import type { CalendarEvent, FlashItem, KlineSeries, NewsDetail, NewsItem, Paged, Quote, QuoteCode } from '../types';
import { apiUrl } from './runtime';

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { kind?: string; tool?: string; message: string };
}

export class ApiError extends Error {
  readonly kind: string;
  constructor(message: string, kind = 'unknown') {
    super(message);
    this.kind = kind;
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(apiUrl(path), { signal, headers: { Accept: 'application/json' } });
  let body: Envelope<T>;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    throw new ApiError(`响应解析失败 (HTTP ${res.status})`, 'parse');
  }
  if (!res.ok || !body.ok) {
    throw new ApiError(body.error?.message ?? `请求失败 (HTTP ${res.status})`, body.error?.kind ?? 'http');
  }
  return body.data as T;
}

const q = (params: Record<string, string | number | undefined>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};

export const api = {
  codes: (signal?: AbortSignal) => get<QuoteCode[]>('/codes', signal),
  quotes: (codes: string[], signal?: AbortSignal) => get<Quote[]>(`/quotes${q({ codes: codes.join(',') })}`, signal),
  kline: (code: string, count = 100, signal?: AbortSignal) =>
    get<KlineSeries>(`/kline/${encodeURIComponent(code)}${q({ count })}`, signal),

  flash: (cursor?: string, signal?: AbortSignal) => get<Paged<FlashItem>>(`/flash${q({ cursor })}`, signal),
  searchFlash: (keyword: string, signal?: AbortSignal) => get<Paged<FlashItem>>(`/flash/search${q({ keyword })}`, signal),

  news: (cursor?: string, signal?: AbortSignal) => get<Paged<NewsItem>>(`/news${q({ cursor })}`, signal),
  searchNews: (keyword: string, cursor?: string, signal?: AbortSignal) =>
    get<Paged<NewsItem>>(`/news/search${q({ keyword, cursor })}`, signal),
  newsDetail: (id: string, signal?: AbortSignal) => get<NewsDetail>(`/news/${encodeURIComponent(id)}`, signal),

  calendar: (signal?: AbortSignal) => get<CalendarEvent[]>('/calendar', signal),

  universe: (signal?: AbortSignal) => get<UniverseMeta>('/universe', signal),
};

// ── 智堡 Wisburg 研究 ───────────────────────────────────────────

export interface WisburgItem {
  id: string;
  title: string;
  time: string;
  summary?: string;
  image?: string;
  category?: string;
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
  content: string;
  url?: string;
  fields: Record<string, string>;
}

export interface Coverage {
  scope: 'core' | 'full';
  codes: number;
  coreCodes: number;
  /** 核心锚品种的刷新周期 */
  coreCycleMs: number;
  /** 长尾品种的刷新周期 */
  cycleMs: number;
  quoteIntervalMs: number;
  klineIntervalMs: number;
  dailyCalls: number;
}

export interface UniverseMeta {
  instruments: Array<{ code: string; label: string; region: string; asset: string; weight?: number }>;
  core: string[];
  regions: Record<string, string>;
  assets: Record<string, string>;
  coverage: Coverage;
  sources: { jin10: boolean; wisburg: boolean; demo?: boolean };
}

/** 切换服务端覆盖范围（core = 9 品种 5 分钟；full = 33 品种）。 */
export async function setScope(scope: 'core' | 'full'): Promise<Coverage> {
  const res = await fetch(apiUrl('/scope'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  });
  const body = (await res.json()) as Envelope<Coverage>;
  if (!res.ok || !body.ok) throw new ApiError(body.error?.message ?? '切换失败');
  return body.data as Coverage;
}

export interface ResearchMeta {
  categories: Array<{ key: string; label: string }>;
  quota: { day: string; resetInMs: number; tools: Array<{ tool: string; used: number; limit: number; remaining: number }> };
}

// ── 主题工作台 ─────────────────────────────────────────────────

export interface TopicDef {
  key: string;
  label: string;
  group: string;
  keyword: string;
  code?: string;
}

export interface TimelineItem {
  id: string;
  source: 'wisburg' | 'jin10';
  kind: 'report' | 'company' | 'feed' | 'article' | 'flash' | 'news';
  kindLabel: string;
  title: string;
  summary?: string;
  time: string;
  ts: number;
  url?: string;
  category?: string;
  companies?: string[];
}

export interface TopicFeed {
  key: string;
  keyword: string;
  label: string;
  code?: string;
  items: TimelineItem[];
  counts: Record<string, number>;
  quote: (Quote & { _at: number }) | null;
}

export interface CompanyFacet {
  name: string;
  count: number;
  refs: Array<{ id: string; title: string; time: string; category: string }>;
}

export const topics = {
  list: (signal?: AbortSignal) =>
    get<{ groups: Record<string, string>; topics: TopicDef[]; wisburg: boolean }>('/topics', signal),
  feed: (key: string, customQuery?: string, signal?: AbortSignal) =>
    get<TopicFeed>(`/topic/${encodeURIComponent(key)}${q({ q: customQuery })}`, signal),
  companies: (signal?: AbortSignal) =>
    get<{ scanned: number; facets: CompanyFacet[] }>('/companies', signal),
};

const listQ = (o: { first?: number; after?: string; query?: string }) =>
  q({ first: o.first, after: o.after, query: o.query });

export const research = {
  meta: (signal?: AbortSignal) => get<ResearchMeta>('/research/meta', signal),
  feed: (o: { first?: number; after?: string; query?: string } = {}, signal?: AbortSignal) =>
    get<WisburgPage>(`/research/feed${listQ(o)}`, signal),
  daily: (o: { first?: number; after?: string; query?: string } = {}, signal?: AbortSignal) =>
    get<WisburgPage>(`/research/daily${listQ(o)}`, signal),
  articles: (o: { first?: number; after?: string; query?: string } = {}, signal?: AbortSignal) =>
    get<WisburgPage>(`/research/articles${listQ(o)}`, signal),
  images: (o: { first?: number; after?: string; query?: string } = {}, signal?: AbortSignal) =>
    get<WisburgPage>(`/research/images${listQ(o)}`, signal),
  reports: (category: string, o: { first?: number; after?: string; query?: string } = {}, signal?: AbortSignal) =>
    get<WisburgPage>(`/research/reports/${category}${listQ(o)}`, signal),
  report: (category: string, id: string, signal?: AbortSignal) =>
    get<WisburgDetail>(`/research/report/${category}/${encodeURIComponent(id)}`, signal),
  article: (id: string, signal?: AbortSignal) => get<WisburgDetail>(`/research/article/${encodeURIComponent(id)}`, signal),
};
