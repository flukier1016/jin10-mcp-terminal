import { Router } from 'express';
import type { Scheduler } from '../core/scheduler.js';
import type { WisburgService } from '../mcp/wisburg.js';
import { buildReport, renderHtml, renderMarkdown, bjFileStamp } from '../core/report.js';
import { TtlCache } from '../core/cache.js';

/**
 * 一键导出市场日报。
 *
 * 行情/日历/快讯/资讯全部取自调度器内存快照，**生成报告不消耗任何金十额度**。
 * 只有 ?research=1 才会额外打 2 次智堡调用（并带 3 分钟缓存）。
 */
export function createReportRouter(scheduler: Scheduler, wisburg: WisburgService | null): Router {
  const router = Router();
  const cache = new TtlCache();

  router.get('/report', async (req, res) => {
    const format = String(req.query.format ?? 'html').toLowerCase();
    const wantResearch = /^(1|true|yes)$/i.test(String(req.query.research ?? ''));
    const download = /^(1|true|yes)$/i.test(String(req.query.download ?? ''));

    const data = buildReport(scheduler, {
      flashLimit: clamp(req.query.flash, 40, 1, 200),
      newsLimit: clamp(req.query.news, 10, 0, 50),
      minStar: clamp(req.query.star, 0, 0, 5),
    });

    if (wantResearch && wisburg) {
      try {
        const [feed, daily] = await Promise.all([
          cache.wrap('rep:feed', 180_000, () => wisburg.listFeed({ first: 8 })),
          cache.wrap('rep:daily', 180_000, () => wisburg.listMarketDaily({ first: 3 })),
        ]);
        data.research = { feed: feed.items ?? [], daily: daily.items ?? [] };
      } catch {
        // 智堡拿不到就不带这一节，不影响报告主体
      }
    }

    const stamp = bjFileStamp();
    const name = `市场日报-${stamp}`;
    const attach = (ext: string) =>
      // filename* 用 RFC 5987 编码，中文文件名在各浏览器才不会乱码
      `${download ? 'attachment' : 'inline'}; filename="market-report-${stamp}.${ext}"; filename*=UTF-8''${encodeURIComponent(name)}.${ext}`;

    if (format === 'json') {
      res.setHeader('Content-Disposition', attach('json'));
      return res.json({ ok: true, data });
    }
    if (format === 'md' || format === 'markdown') {
      res.type('text/markdown; charset=utf-8').setHeader('Content-Disposition', attach('md'));
      return res.send(renderMarkdown(data));
    }
    res.type('text/html; charset=utf-8').setHeader('Content-Disposition', attach('html'));
    return res.send(renderHtml(data));
  });

  return router;
}

function clamp(raw: unknown, dflt: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
