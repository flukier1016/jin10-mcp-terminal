import { Router } from 'express';
import type { WisburgService, ReportCategory } from '../mcp/wisburg.js';
import { CATEGORY_LABEL } from '../mcp/wisburg.js';
import { TtlCache } from '../core/cache.js';
import type { QuotaLedger } from '../core/quota.js';
import { McpProtocolError, McpRateLimitError, McpToolError } from '../mcp/client.js';
import { WISBURG_TOOLS } from '../mcp/wisburg.js';

const TTL = { list: 90_000, search: 5 * 60_000, detail: 30 * 60_000 } as const;
const CATEGORIES: ReportCategory[] = ['ib', 'company', 'am', 'archive', 'ec'];

/** 智堡研究路由。列表/详情都过缓存，同一页在窗口内只打一次真实调用。 */
export function createResearchRouter(wisburg: WisburgService, ledger: QuotaLedger): Router {
  const router = Router();
  const cache = new TtlCache();
  const ok = <T>(data: T) => ({ ok: true as const, data });

  const listArgs = (req: import('express').Request) => ({
    first: req.query.first ? Number(req.query.first) : 20,
    ...(req.query.after ? { after: String(req.query.after) } : {}),
    ...(req.query.query ? { query: String(req.query.query) } : {}),
    ...(req.query.startTime ? { startTime: String(req.query.startTime) } : {}),
    ...(req.query.endTime ? { endTime: String(req.query.endTime) } : {}),
  });

  const key = (prefix: string, req: import('express').Request) =>
    `${prefix}:${JSON.stringify(listArgs(req))}`;

  router.get('/meta', (_req, res) => {
    res.json(
      ok({
        categories: CATEGORIES.map((c) => ({ key: c, label: CATEGORY_LABEL[c] })),
        quota: ledger.snapshot(WISBURG_TOOLS.map((tool) => ({ tool, intervalMs: 0 }))),
      }),
    );
  });

  router.get('/feed', async (req, res, next) => {
    try {
      const args = listArgs(req);
      res.json(ok(await cache.wrap(key('feed', req), args.query ? TTL.search : TTL.list, () => wisburg.listFeed(args))));
    } catch (err) {
      next(err);
    }
  });

  router.get('/daily', async (req, res, next) => {
    try {
      const args = listArgs(req);
      res.json(ok(await cache.wrap(key('daily', req), TTL.list, () => wisburg.listMarketDaily(args))));
    } catch (err) {
      next(err);
    }
  });

  router.get('/articles', async (req, res, next) => {
    try {
      const args = listArgs(req);
      res.json(
        ok(await cache.wrap(key('articles', req), args.query ? TTL.search : TTL.list, () => wisburg.listArticles(args))),
      );
    } catch (err) {
      next(err);
    }
  });

  router.get('/images', async (req, res, next) => {
    try {
      const args = listArgs(req);
      res.json(ok(await cache.wrap(key('images', req), TTL.list, () => wisburg.listImages(args))));
    } catch (err) {
      next(err);
    }
  });

  router.get('/reports/:category', async (req, res, next) => {
    try {
      const category = req.params.category as ReportCategory;
      if (!CATEGORIES.includes(category)) {
        return res.status(400).json({ ok: false, error: { message: `未知分类 ${category}` } });
      }
      const args = listArgs(req);
      res.json(
        ok(
          await cache.wrap(key(`rep:${category}`, req), args.query ? TTL.search : TTL.list, () =>
            wisburg.listReports(category, args),
          ),
        ),
      );
    } catch (err) {
      next(err);
    }
  });

  router.get('/report/:category/:id', async (req, res, next) => {
    try {
      const category = req.params.category as ReportCategory;
      if (!CATEGORIES.includes(category)) {
        return res.status(400).json({ ok: false, error: { message: `未知分类 ${category}` } });
      }
      const id = String(req.params.id);
      res.json(ok(await cache.wrap(`detail:${category}:${id}`, TTL.detail, () => wisburg.getReport(id, category))));
    } catch (err) {
      next(err);
    }
  });

  router.get('/article/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      res.json(ok(await cache.wrap(`article:${id}`, TTL.detail, () => wisburg.getArticle(id))));
    } catch (err) {
      next(err);
    }
  });

  router.use(
    (
      err: unknown,
      _req: import('express').Request,
      res: import('express').Response,
      _next: import('express').NextFunction,
    ) => {
      if (err instanceof McpRateLimitError) {
        return res.status(429).json({ ok: false, error: { kind: 'rate_limit', tool: err.tool, message: err.detail } });
      }
      if (err instanceof McpToolError) {
        return res.status(502).json({ ok: false, error: { kind: 'tool', tool: err.tool, message: err.detail } });
      }
      if (err instanceof McpProtocolError) {
        return res.status(502).json({ ok: false, error: { kind: 'protocol', code: err.code, message: err.message } });
      }
      res.status(500).json({ ok: false, error: { kind: 'internal', message: err instanceof Error ? err.message : String(err) } });
    },
  );

  return router;
}
