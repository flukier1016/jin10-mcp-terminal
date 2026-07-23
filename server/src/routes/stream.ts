import { Router } from 'express';
import type { StreamBus } from '../core/bus.js';
import type { Scheduler } from '../core/scheduler.js';
import { config } from '../config.js';

/**
 * SSE 实时通道：`GET /api/stream?codes=A,B,C&focus=A`
 *
 * 连接建立后立刻回填当前快照（行情 / 快讯 / 日历），
 * 前端因此不需要为首屏再发一轮 REST 请求。
 */
export function createStreamRouter(bus: StreamBus, scheduler: Scheduler): Router {
  const router = Router();

  router.get('/stream', (req, res) => {
    const codes = String(req.query.codes ?? '')
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    const watch = codes.length ? codes : [...config.watchlist];
    const focusRaw = String(req.query.focus ?? '').trim().toUpperCase();
    const focus = focusRaw || watch[0] || null;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // 关掉反代缓冲，否则事件会被攒住
    });
    res.write(': connected\n\n');

    const id = bus.add(res, watch, focus);

    bus.sendTo(id, {
      type: 'hello',
      serverTime: Date.now(),
      quota: scheduler.quotaSnapshot(),
      codes: scheduler.codes,
    });
    bus.sendTo(id, { type: 'status', mcp: 'up' });

    // 首屏回填
    for (const code of watch) {
      const snap = scheduler.quotes.get(code);
      if (snap) bus.sendTo(id, { type: 'quote', quote: snap.quote, at: snap.at });
    }
    const kl = focus ? scheduler.klines.get(focus) : undefined;
    if (kl) {
      bus.sendTo(id, { type: 'kline', code: focus!, name: kl.name, bars: kl.bars, at: kl.at });
    }
    if (scheduler.flashes.length) {
      bus.sendTo(id, { type: 'flash', items: scheduler.flashes.slice(0, 40), at: Date.now() });
    }
    if (scheduler.news.length) {
      bus.sendTo(id, { type: 'news', items: scheduler.news.slice(0, 20), at: Date.now() });
    }
    if (scheduler.calendar.length) {
      bus.sendTo(id, { type: 'calendar', events: scheduler.calendar, at: Date.now() });
    }

    req.on('close', () => bus.remove(id));
    req.on('error', () => bus.remove(id));
  });

  /** 不断线更新订阅（改自选/切聚焦时用，避免重建 SSE）。 */
  router.post('/stream/:id/subscribe', (req, res) => {
    const id = Number(req.params.id);
    const body = req.body as { codes?: string[]; focus?: string } | undefined;
    const codes = (body?.codes ?? []).map((c) => String(c).trim().toUpperCase()).filter(Boolean);
    bus.update(id, codes, body?.focus ? String(body.focus).toUpperCase() : null);
    res.json({ ok: true });
  });

  return router;
}
