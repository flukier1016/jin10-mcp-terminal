import { useEffect, useRef, useState } from 'react';
import type {
  CalendarEvent,
  ConnState,
  FlashItem,
  KlineBar,
  NewsItem,
  Quote,
  QuoteCode,
  QuotaSnapshot,
} from '../types';

export interface QuoteTick {
  quote: Quote;
  at: number;
  /** 相对上一笔的方向，用于触发闪烁动画。 */
  dir: 'up' | 'down' | 'flat';
  /** 每次收到推送自增，作为动画的 key。 */
  seq: number;
}

export interface KlineSnapshot {
  code: string;
  bars: KlineBar[];
  at: number;
}

export interface StreamState {
  conn: ConnState;
  quotes: Map<string, QuoteTick>;
  kline: KlineSnapshot | null;
  flashes: FlashItem[];
  freshFlash: Set<string>;
  news: NewsItem[];
  calendar: CalendarEvent[];
  quota: QuotaSnapshot | null;
  codes: QuoteCode[];
  lastEventAt: number;
}

const flashKey = (i: FlashItem) => i.id ?? i.url ?? `${i.time}|${i.content.slice(0, 40)}`;

/**
 * 订阅服务端 SSE。
 *
 * 自选或聚焦变化时重建连接 —— 重连本身不消耗金十额度（服务端只是换个订阅集合），
 * 换来的是新品种立刻被纳入轮询并立即回填首屏快照。
 */
export function useStream(codes: string[], focus: string | null): StreamState {
  const [state, setState] = useState<StreamState>({
    conn: 'connecting',
    quotes: new Map(),
    kline: null,
    flashes: [],
    freshFlash: new Set(),
    news: [],
    calendar: [],
    quota: null,
    codes: [],
    lastEventAt: 0,
  });

  const seqRef = useRef(0);
  const key = `${[...codes].sort().join(',')}|${focus ?? ''}`;

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: number | null = null;
    let backoff = 1000;
    let alive = true;

    const connect = () => {
      if (!alive) return;
      const url = `/api/stream?codes=${encodeURIComponent(codes.join(','))}&focus=${encodeURIComponent(focus ?? '')}`;
      es = new EventSource(url);

      es.onopen = () => {
        backoff = 1000;
        setState((s) => ({ ...s, conn: 'live' }));
      };

      es.onerror = () => {
        setState((s) => ({ ...s, conn: 'down' }));
        es?.close();
        if (!alive) return;
        retry = window.setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 15_000);
      };

      const on = <T,>(type: string, fn: (d: T) => void) => {
        es?.addEventListener(type, (ev) => {
          try {
            fn(JSON.parse((ev as MessageEvent).data) as T);
          } catch {
            /* 忽略坏帧 */
          }
        });
      };

      on<{ quota: QuotaSnapshot; codes: QuoteCode[] }>('hello', (d) => {
        setState((s) => ({ ...s, conn: 'live', quota: d.quota, codes: d.codes ?? [], lastEventAt: Date.now() }));
      });

      on<{ quote: Quote; at: number }>('quote', (d) => {
        setState((s) => {
          const prev = s.quotes.get(d.quote.code);
          const before = prev ? Number(prev.quote.close) : NaN;
          const after = Number(d.quote.close);
          const dir: QuoteTick['dir'] =
            !Number.isFinite(before) || before === after ? 'flat' : after > before ? 'up' : 'down';
          const quotes = new Map(s.quotes);
          quotes.set(d.quote.code, { quote: d.quote, at: d.at, dir, seq: ++seqRef.current });
          return { ...s, quotes, lastEventAt: Date.now() };
        });
      });

      on<{ code: string; bars: KlineBar[]; at: number }>('kline', (d) => {
        setState((s) => ({ ...s, kline: { code: d.code, bars: d.bars ?? [], at: d.at }, lastEventAt: Date.now() }));
      });

      on<{ items: FlashItem[] }>('flash', (d) => {
        setState((s) => {
          const seen = new Set(s.flashes.map(flashKey));
          const fresh = (d.items ?? []).filter((i) => !seen.has(flashKey(i)));
          if (!fresh.length) return { ...s, lastEventAt: Date.now() };
          // 首屏回填的一整批不该全部高亮，只有增量推送才标记为"新"
          const isBackfill = s.flashes.length === 0;
          return {
            ...s,
            flashes: [...fresh, ...s.flashes].slice(0, 400),
            freshFlash: isBackfill ? s.freshFlash : new Set([...fresh.map(flashKey), ...s.freshFlash].slice(0, 60)),
            lastEventAt: Date.now(),
          };
        });
      });

      on<{ items: NewsItem[] }>('news', (d) => {
        setState((s) => {
          const seen = new Set(s.news.map((n) => n.id));
          const fresh = (d.items ?? []).filter((n) => !seen.has(n.id));
          if (!fresh.length) return s;
          return { ...s, news: [...fresh, ...s.news].slice(0, 200), lastEventAt: Date.now() };
        });
      });

      on<{ events: CalendarEvent[] }>('calendar', (d) => {
        setState((s) => ({ ...s, calendar: d.events ?? [], lastEventAt: Date.now() }));
      });

      on<{ quota: QuotaSnapshot }>('quota', (d) => setState((s) => ({ ...s, quota: d.quota })));
      on<unknown>('ping', () => setState((s) => ({ ...s, conn: 'live' })));
    };

    connect();
    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
      es?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}

/** 每秒滴答一次，供"N秒前"这类相对时间实时走动。 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
