import { Router } from 'express';
import type { Jin10Service } from '../mcp/jin10.js';
import type { Scheduler } from '../core/scheduler.js';
import { TtlCache } from '../core/cache.js';
import { McpRateLimitError, McpToolError, McpProtocolError } from '../mcp/client.js';
import { config } from '../config.js';

/** 按需接口的缓存时长 —— 直接决定同样的浏览行为要烧掉多少额度。 */
const TTL = {
  kline: 20_000,
  search: 60_000,
  newsDetail: 10 * 60_000,
  newsPage: 45_000,
  flashPage: 15_000,
  codes: 60 * 60_000,
} as const;

export function createApiRouter(jin10: Jin10Service, scheduler: Scheduler): Router {
  const router = Router();
  const cache = new TtlCache();

  const ok = <T>(data: T) => ({ ok: true as const, data });

  router.get('/health', (_req, res) => {
    const status = scheduler.status;
    res.json(
      ok({
        status: 'ok',
        clients: status.clients,
        lastError: status.lastError,
        quotaPersistence: status.quotaPersistence,
        uptime: Math.round(process.uptime()),
      }),
    );
  });

  router.get('/config', (_req, res) => {
    res.json(
      ok({
        mode: config.demoMode ? 'demo' : 'live',
        watchlist: config.watchlist,
        sustainHours: config.quota.sustainHours,
        quotaPersistence: scheduler.status.quotaPersistence,
      }),
    );
  });

  router.get('/quota', (_req, res) => res.json(ok(scheduler.quotaSnapshot())));

  /** 品种列表：走 resources/read，不消耗工具额度。 */
  router.get('/codes', async (_req, res, next) => {
    try {
      if (scheduler.codes.length) return res.json(ok(scheduler.codes));
      const codes = await cache.wrap('codes', TTL.codes, () => jin10.quoteCodes());
      res.json(ok(codes));
    } catch (err) {
      next(err);
    }
  });

  /** 行情快照：优先返回调度器的推送缓存，避免重复调用。 */
  router.get('/quotes', async (req, res, next) => {
    try {
      const codes = String(req.query.codes ?? '')
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean);
      const wanted = codes.length ? codes : config.watchlist;

      const out = [];
      for (const code of wanted) {
        const cached = scheduler.quotes.get(code);
        if (cached) {
          out.push({ ...cached.quote, _at: cached.at, _cached: true });
          continue;
        }
        const quote = await jin10.getQuote(code);
        const at = Date.now();
        scheduler.quotes.set(code, { quote, at });
        out.push({ ...quote, _at: at, _cached: false });
      }
      res.json(ok(out));
    } catch (err) {
      next(err);
    }
  });

  router.get('/kline/:code', async (req, res, next) => {
    try {
      const code = req.params.code.toUpperCase();
      const count = Math.min(100, Math.max(1, Number(req.query.count) || 100));
      const time = req.query.time ? Number(req.query.time) : undefined;
      const key = `kline:${code}:${count}:${time ?? 'now'}`;
      const data = await cache.wrap(key, TTL.kline, () => jin10.getKline(code, { count, time }));
      res.json(ok(data));
    } catch (err) {
      next(err);
    }
  });

  /** 快讯列表。首屏无 cursor 时直接吃调度器缓冲，零额度消耗。 */
  router.get('/flash', async (req, res, next) => {
    try {
      const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
      if (!cursor && scheduler.flashes.length) {
        return res.json(ok({ items: scheduler.flashes.slice(0, 30), next_cursor: null, has_more: true, _live: true }));
      }
      const data = await cache.wrap(`flash:${cursor ?? 'head'}`, TTL.flashPage, () => jin10.listFlash(cursor));
      res.json(ok(data));
    } catch (err) {
      next(err);
    }
  });

  router.get('/flash/search', async (req, res, next) => {
    try {
      const keyword = String(req.query.keyword ?? '').trim();
      if (!keyword) return res.status(400).json({ ok: false, error: { message: '缺少 keyword' } });
      const data = await cache.wrap(`sflash:${keyword}`, TTL.search, () => jin10.searchFlash(keyword));
      res.json(ok(data));
    } catch (err) {
      next(err);
    }
  });

  router.get('/news', async (req, res, next) => {
    try {
      const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
      if (!cursor && scheduler.news.length) {
        return res.json(ok({ items: scheduler.news.slice(0, 20), next_cursor: null, has_more: true, _live: true }));
      }
      const data = await cache.wrap(`news:${cursor ?? 'head'}`, TTL.newsPage, () => jin10.listNews(cursor));
      res.json(ok(data));
    } catch (err) {
      next(err);
    }
  });

  router.get('/news/search', async (req, res, next) => {
    try {
      const keyword = String(req.query.keyword ?? '').trim();
      if (!keyword) return res.status(400).json({ ok: false, error: { message: '缺少 keyword' } });
      const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
      const data = await cache.wrap(`snews:${keyword}:${cursor ?? '0'}`, TTL.search, () =>
        jin10.searchNews(keyword, cursor),
      );
      res.json(ok(data));
    } catch (err) {
      next(err);
    }
  });

  router.get('/news/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const data = await cache.wrap(`newsdetail:${id}`, TTL.newsDetail, () => jin10.getNews(id));
      res.json(ok(data));
    } catch (err) {
      next(err);
    }
  });

  router.get('/calendar', async (_req, res, next) => {
    try {
      if (scheduler.calendar.length) return res.json(ok(scheduler.calendar));
      const data = await cache.wrap('calendar', 5 * 60_000, () => jin10.listCalendar());
      res.json(ok(data));
    } catch (err) {
      next(err);
    }
  });

  // 统一错误出口：把 MCP 的三类错误映射成合适的 HTTP 语义
  router.use((err: unknown, _req: import('express').Request, res: import('express').Response, _next: import('express').NextFunction) => {
    if (err instanceof McpRateLimitError) {
      return res.status(429).json({ ok: false, error: { kind: 'rate_limit', tool: err.tool, message: err.detail } });
    }
    if (err instanceof McpToolError) {
      return res.status(502).json({ ok: false, error: { kind: 'tool', tool: err.tool, message: err.detail } });
    }
    if (err instanceof McpProtocolError) {
      return res.status(502).json({ ok: false, error: { kind: 'protocol', code: err.code, message: err.message } });
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: { kind: 'internal', message } });
  });

  return router;
}
