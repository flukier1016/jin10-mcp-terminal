import { Router } from 'express';
import type { Jin10Service } from '../mcp/jin10.js';
import type { WisburgService } from '../mcp/wisburg.js';
import type { Scheduler } from '../core/scheduler.js';
import { TtlCache } from '../core/cache.js';
import {
  TOPICS,
  TOPIC_BY_KEY,
  TOPIC_GROUP_LABEL,
  buildCompanyFacets,
  extractCompanies,
} from '../core/topics.js';
import { McpProtocolError, McpRateLimitError, McpToolError } from '../mcp/client.js';

/** 合并时间线里的一条，来源用 source 区分。 */
interface TimelineItem {
  id: string;
  source: 'wisburg' | 'jin10';
  kind: 'report' | 'company' | 'feed' | 'article' | 'flash' | 'news';
  kindLabel: string;
  title: string;
  summary?: string;
  time: string;
  ts: number;
  url?: string;
  /** 智堡详情需要 category 才能取 */
  category?: string;
  companies?: string[];
}

const KIND_LABEL: Record<TimelineItem['kind'], string> = {
  report: '投行研报',
  company: '企业研究',
  feed: '投研资讯',
  article: '深度文章',
  flash: '金十快讯',
  news: '金十资讯',
};

const TTL = { topic: 5 * 60_000, companies: 10 * 60_000 } as const;

/**
 * 主题工作台。
 *
 * 一次请求把智堡（研报/企业研究/资讯流）与金十（快讯/资讯）按同一关键词
 * 并发搜索，合并成一条按时间倒序的时间线 —— 研究观点和盘面消息放在一起看，
 * 而不是在两个页面之间来回切。
 *
 * 缓存模式只调用金十；实时研究开启时才追加智堡 3 路搜索。结果缓存 5 分钟。
 */
export function createTopicRouter(
  jin10: Jin10Service,
  wisburg: WisburgService | null,
  scheduler: Scheduler,
): Router {
  const router = Router();
  const cache = new TtlCache();
  const ok = <T>(data: T) => ({ ok: true as const, data });

  router.get('/topics', (_req, res) => {
    res.json(
      ok({
        groups: TOPIC_GROUP_LABEL,
        topics: TOPICS.map((t) => ({
          key: t.key,
          label: t.label,
          group: t.group,
          keyword: t.keywords[0],
          ...(t.code ? { code: t.code } : {}),
        })),
        wisburg: wisburg !== null,
      }),
    );
  });

  /** 单个主题的合并时间线。也支持 ?q= 直接搜任意关键词（公司维度复用这条）。 */
  router.get('/topic/:key', async (req, res, next) => {
    try {
      const key = String(req.params.key);
      const custom = String(req.query.q ?? '').trim();
      const topic = TOPIC_BY_KEY.get(key);

      if (!topic && !custom) {
        return res.status(404).json({ ok: false, error: { message: `未知主题 ${key}` } });
      }
      const keyword = custom || topic!.keywords[0]!;
      const code = topic?.code;

      const data = await cache.wrap(`topic:${key}:${keyword}`, TTL.topic, async () => {
        const items = await gather(jin10, wisburg, keyword);
        return {
          key,
          keyword,
          label: topic?.label ?? custom,
          ...(code ? { code } : {}),
          items,
          counts: countBy(items),
        };
      });

      // 报价不进缓存，始终取调度器里的最新快照
      const quote = code ? scheduler.quotes.get(code) : undefined;
      res.json(ok({ ...data, quote: quote ? { ...quote.quote, _at: quote.at } : null }));
    } catch (err) {
      next(err);
    }
  });

  /** 公司分面：从最近的企业研究 + 电话会纪要标题里抽取并按频次排序。 */
  router.get('/companies', async (_req, res, next) => {
    if (!wisburg) return res.json(ok({ scanned: 0, facets: [] }));
    try {
      const data = await cache.wrap('companies', TTL.companies, async () => {
        const [company, calls] = await Promise.all([
          wisburg.listReports('company', { first: 60 }).catch(() => null),
          wisburg.listReports('ec', { first: 40 }).catch(() => null),
        ]);
        const merged = [
          ...(company?.items ?? []).map((i) => ({ ...i, category: 'company' })),
          ...(calls?.items ?? []).map((i) => ({ ...i, category: 'ec' })),
        ];
        const facets = buildCompanyFacets(merged);
        return {
          scanned: merged.length,
          // 只出现一次且没进词典的候选噪声大，压到后面但不丢
          facets: facets.slice(0, 60),
        };
      });
      res.json(ok(data));
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
      res
        .status(500)
        .json({ ok: false, error: { kind: 'internal', message: err instanceof Error ? err.message : String(err) } });
    },
  );

  return router;
}

/** 五路并发搜索，任一路失败不影响其它路。 */
async function gather(
  jin10: Jin10Service,
  wisburg: WisburgService | null,
  keyword: string,
): Promise<TimelineItem[]> {
  const tasks: Array<Promise<TimelineItem[]>> = [
    jin10
      .searchFlash(keyword)
      .then((p) =>
        (p.items ?? []).slice(0, 25).map((f) => ({
          id: f.id ?? f.url,
          source: 'jin10' as const,
          kind: 'flash' as const,
          kindLabel: KIND_LABEL.flash,
          title: f.content,
          time: f.time,
          ts: Date.parse(f.time) || 0,
          url: f.url,
        })),
      )
      .catch(() => []),

    jin10
      .searchNews(keyword)
      .then((p) =>
        (p.items ?? []).slice(0, 12).map((n) => ({
          id: n.id,
          source: 'jin10' as const,
          kind: 'news' as const,
          kindLabel: KIND_LABEL.news,
          title: n.title,
          ...(n.introduction ? { summary: n.introduction } : {}),
          time: n.time,
          ts: Date.parse(n.time) || 0,
          url: n.url,
        })),
      )
      .catch(() => []),
  ];

  if (wisburg) {
    const wis = (
      kind: 'report' | 'company' | 'feed',
      p: Promise<{ items: Array<{ id: string; title: string; time: string; summary?: string }> }>,
      category: string,
    ) =>
      p
        .then((r) =>
          (r.items ?? []).slice(0, 15).map((i) => ({
            id: i.id,
            source: 'wisburg' as const,
            kind,
            kindLabel: KIND_LABEL[kind],
            title: i.title,
            ...(i.summary ? { summary: i.summary } : {}),
            time: i.time,
            ts: Date.parse(i.time) || 0,
            category,
            companies: extractCompanies(i.title),
          })),
        )
        .catch(() => [] as TimelineItem[]);

    tasks.push(
      wis('report', wisburg.listReports('ib', { first: 15, query: keyword }), 'ib'),
      wis('company', wisburg.listReports('company', { first: 15, query: keyword }), 'company'),
      wis('feed', wisburg.listFeed({ first: 15, query: keyword }), 'ib'),
    );
  }

  const all = (await Promise.all(tasks)).flat();

  // 同一条内容可能同时出现在资讯流与投行研报里（id 相同），按 source+id 去重
  const seen = new Set<string>();
  const out: TimelineItem[] = [];
  for (const it of all) {
    const k = `${it.source}:${it.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out.sort((a, b) => b.ts - a.ts);
}

function countBy(items: TimelineItem[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const i of items) c[i.kind] = (c[i.kind] ?? 0) + 1;
  return c;
}
