import { config } from '../config.js';
import type { Jin10Service } from '../mcp/jin10.js';
import type { QuotaLedger } from './quota.js';
import type { StreamBus } from './bus.js';
import { McpRateLimitError } from '../mcp/client.js';
import { CORE_CODES, weightOf, type Scope } from './universe.js';
import type { CalendarEvent, FlashItem, KlineBar, NewsItem, Quote, QuoteCode } from '../types.js';

/**
 * 额度感知的轮询调度器。
 *
 * 设计要点：
 *  1. 24/7 常驻：SUSTAIN_HOURS=24 时，间隔正好落在 86400s / 1350 次 ≈ 64 秒，
 *     即把每个工具的日额度铺满一整天而不会提前耗尽。
 *  2. get_quote 与 get_kline 是两套独立的 1500/天额度。用 get_quote 播种拿到
 *     今开/名称，之后用 get_kline 只取最新分钟线的收盘价并按今开重算涨跌幅 ——
 *     等效把行情刷新吞吐翻倍到 2700 次/天。
 *  3. 选品种用"加权最陈旧优先"，而不是固定环形轮转：新加入的品种立刻被补齐，
 *     宏观锚（黄金/原油/美元/美股/中国）靠权重拿到更高的刷新频率。
 */
export class Scheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  /** 行情最新快照，新连接进来可立即回填而不必额外调用。 */
  readonly quotes = new Map<string, { quote: Quote; at: number }>();
  /** 聚焦品种的 K 线快照。 */
  readonly klines = new Map<string, { name: string; bars: KlineBar[]; at: number }>();
  /** 快讯滚动缓冲（按 url/id 去重）。 */
  readonly flashes: FlashItem[] = [];
  private flashSeen = new Set<string>();
  readonly news: NewsItem[] = [];
  private newsSeen = new Set<string>();
  calendar: CalendarEvent[] = [];
  codes: QuoteCode[] = [];

  private lastError: string | null = null;
  private startedAt = Date.now();

  /**
   * 覆盖范围。core = 只轮询核心 9 品种（每个约 5 分钟刷新一次，24/7），
   * full = 覆盖全部 33 个品种（核心约 7 分钟，长尾更慢）。
   */
  scope: Scope = 'full';

  constructor(
    private readonly jin10: Jin10Service,
    private readonly ledger: QuotaLedger,
    private readonly bus: StreamBus,
  ) {}

  async start(): Promise<void> {
    // 品种列表走 resources/read，不计入工具额度，启动时拉一次即可。
    try {
      this.codes = await this.jin10.quoteCodes();
    } catch (err) {
      this.lastError = errMsg(err);
    }

    this.loop('quote', () => this.tickQuote());
    this.loop('kline', () => this.tickKline());
    this.loop('flash', () => this.tickFlash());
    this.loop('news', () => this.tickNews());
    this.loop('calendar', () => this.tickCalendar());

    const quotaTimer = setInterval(() => this.bus.broadcast({ type: 'quota', quota: this.quotaSnapshot() }), 5_000);
    this.timers.set('quota', quotaTimer);

    // 心跳，防止中间层掐断闲置的 SSE 连接
    const ping = setInterval(() => this.bus.broadcast({ type: 'ping', at: Date.now() }), 25_000);
    this.timers.set('ping', ping);

    this.bus.onChange(() => {
      this.kick('quote');
      this.kick('kline');
    });
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t as unknown as NodeJS.Timeout);
    this.timers.clear();
  }

  get status() {
    return {
      lastError: this.lastError,
      clients: this.bus.size,
      uptimeMs: Date.now() - this.startedAt,
      quotaPersistence: this.ledger.persistenceStatus,
    };
  }

  // ── 循环骨架 ───────────────────────────────────────────────────

  private loop(key: PollKey, fn: () => Promise<number>): void {
    const run = async () => {
      if (this.stopped) return;
      let delay: number = config.poll[key].max;
      try {
        delay = await fn();
      } catch (err) {
        this.lastError = errMsg(err);
        delay = err instanceof McpRateLimitError ? config.poll[key].max : Math.max(delay, 15_000);
      }
      if (this.stopped) return;
      this.timers.set(key, setTimeout(run, delay));
    };
    this.timers.set(key, setTimeout(run, 0));
  }

  /** 立刻重排某个循环（订阅变化时用），不重复叠加定时器。 */
  private kick(key: PollKey): void {
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    const fns: Record<PollKey, () => Promise<number>> = {
      quote: () => this.tickQuote(),
      kline: () => this.tickKline(),
      flash: () => this.tickFlash(),
      news: () => this.tickNews(),
      calendar: () => this.tickCalendar(),
    };
    const run = async () => {
      if (this.stopped) return;
      let delay: number = config.poll[key].max;
      try {
        delay = await fns[key]();
      } catch (err) {
        this.lastError = errMsg(err);
        delay = 15_000;
      }
      if (!this.stopped) this.timers.set(key, setTimeout(run, delay));
    };
    this.timers.set(key, setTimeout(run, 60));
  }

  /** 24/7 模式下永不待机；否则无客户端时零消耗。 */
  private idle(): boolean {
    return this.bus.size === 0 && !config.quota.pollWhenIdle;
  }

  /**
   * 当前需要覆盖的品种集合。
   *
   * core 模式下只覆盖核心 9 品种 + 用户正在看的那个，把全部额度压在少数标的上，
   * 换来每个 5 分钟一次的稳定刷新。
   */
  private targetCodes(): string[] {
    if (this.scope === 'core') {
      const set = new Set<string>(CORE_CODES);
      for (const c of this.bus.focusedCodes()) set.add(c);
      return [...set];
    }
    const base = config.quota.alwaysOnUniverse ? config.universe : [];
    const set = new Set<string>([...base, ...this.bus.subscribedCodes()]);
    if (!set.size) for (const c of config.watchlist) set.add(c);
    return [...set];
  }

  /**
   * 加权最陈旧优先：得分 = 已过去的时间 × 权重，取最高分。
   * 从未取过的品种得分为无穷大，因此总是先补齐冷启动。
   */
  private pickStalest(codes: string[], focused: Set<string>): string | null {
    const now = Date.now();
    let best: string | null = null;
    let bestScore = -1;
    for (const code of codes) {
      const snap = this.quotes.get(code);
      const age = snap ? now - snap.at : Number.POSITIVE_INFINITY;
      const w = weightOf(code) * (focused.has(code) ? config.quota.focusBoost : 1);
      const score = age === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : age * w;
      if (score > bestScore) {
        bestScore = score;
        best = code;
      }
      if (score === Number.POSITIVE_INFINITY) break; // 冷启动优先，无需继续比较
    }
    return best;
  }

  // ── 各任务 ────────────────────────────────────────────────────

  /**
   * 行情主通道：完整快照（今开/最高/最低/成交量/涨跌幅）。
   *
   * 冷启动阶段（还有品种一次都没取过）用最小间隔连续打完 —— 33 个品种一次性
   * 花掉约 2% 的日额度，换来打开就是满屏数据，而不是等十几分钟慢慢长出来。
   */
  private async tickQuote(): Promise<number> {
    if (this.idle()) return 3_000;
    const delay = this.ledger.suggestIntervalMs('get_quote', config.poll.quote.min, config.poll.quote.max);
    if (!this.ledger.canSpend('get_quote')) return config.poll.quote.max;

    const codes = this.targetCodes();
    const cold = codes.find((c) => !this.quotes.has(c));
    const code = cold ?? this.pickStalest(codes, this.bus.focusedCodes());
    if (!code) return 5_000;

    const quote = await this.jin10.getQuote(code);
    this.publishQuote(code, quote);
    this.lastError = null;

    // 还有没播种的品种就继续冲刺
    return codes.some((c) => !this.quotes.has(c)) ? COLD_START_MS : delay;
  }

  /**
   * K 线通道，一线两用：
   *  - 有人正在看某个品种 → 拉 100 根分钟线喂图表（顺带刷新该品种价格）
   *  - 没人聚焦 → 拿它当第二条行情通道，只取最近 2 根线刷新最陈旧品种的价格
   */
  private async tickKline(): Promise<number> {
    if (this.idle()) return 5_000;
    const delay = this.ledger.suggestIntervalMs('get_kline', config.poll.kline.min, config.poll.kline.max);
    if (!this.ledger.canSpend('get_kline')) return config.poll.kline.max;

    const focused = [...this.bus.focusedCodes()];
    const chartCode = focused[0];

    if (chartCode) {
      const series = await this.jin10.getKline(chartCode, { count: 100 });
      const at = Date.now();
      this.klines.set(chartCode, { name: series.name, bars: series.klines, at });
      if (this.klines.size > 12) this.klines.delete([...this.klines.keys()][0]!);
      this.bus.broadcast({ type: 'kline', code: chartCode, name: series.name, bars: series.klines, at });
      this.refreshPriceFromBar(chartCode, series.klines.at(-1));
      this.lastError = null;
      return delay;
    }

    // 无人聚焦：把这条额度用来加速总览刷新
    const code = this.pickStalest(this.targetCodes(), new Set());
    if (!code) return 10_000;
    // 没有 get_quote 播种过的品种拿不到今开，先让 get_quote 处理
    if (!this.quotes.has(code)) return Math.max(delay, config.poll.kline.min);

    const series = await this.jin10.getKline(code, { count: 2 });
    this.refreshPriceFromBar(code, series.klines.at(-1));
    this.lastError = null;
    return delay;
  }

  /**
   * 用最新分钟线的收盘价刷新已有快照。
   *
   * 今开来自之前的 get_quote，所以涨跌幅可以在本地正确重算；
   * 最高/最低取运行时的滚动极值；成交量是分钟量而非累计量，因此保留原值不动。
   */
  private refreshPriceFromBar(code: string, bar: KlineBar | undefined): void {
    if (!bar) return;
    const prev = this.quotes.get(code);
    if (!prev) return;

    const close = Number(bar.close);
    const open = Number(prev.quote.open);
    if (!Number.isFinite(close) || !Number.isFinite(open) || open === 0) return;

    const diff = close - open;
    const next: Quote = {
      ...prev.quote,
      close: bar.close,
      high: String(Math.max(Number(prev.quote.high), Number(bar.high))),
      low: String(Math.min(Number(prev.quote.low), Number(bar.low))),
      ups_price: diff.toFixed(decimalsOf(prev.quote.close)),
      ups_percent: ((diff / open) * 100).toFixed(2),
      time: new Date(bar.time * 1000).toISOString(),
    };
    this.publishQuote(code, next);
  }

  private publishQuote(code: string, quote: Quote): void {
    const at = Date.now();
    const prev = this.quotes.get(code);
    this.quotes.set(code, { quote, at });
    // 价格没动就不占下行带宽；但超过 30 秒仍推一次，让前端知道链路是活的
    if (!prev || prev.quote.close !== quote.close || at - prev.at > 30_000) {
      this.bus.broadcast({ type: 'quote', quote, at });
    }
  }

  private async tickFlash(): Promise<number> {
    if (this.idle()) return 3_000;
    const delay = this.ledger.suggestIntervalMs('list_flash', config.poll.flash.min, config.poll.flash.max);
    if (!this.ledger.canSpend('list_flash')) return config.poll.flash.max;

    const page = await this.jin10.listFlash();
    const fresh = (page.items ?? []).filter((i) => !this.flashSeen.has(flashKey(i)));
    if (fresh.length) {
      for (const i of fresh) this.flashSeen.add(flashKey(i));
      this.flashes.unshift(...fresh);
      this.flashes.splice(500);
      trim(this.flashSeen, 2500);
      this.bus.broadcast({ type: 'flash', items: fresh, at: Date.now() });
    }
    this.lastError = null;
    return delay;
  }

  private async tickNews(): Promise<number> {
    if (this.idle()) return 5_000;
    const delay = this.ledger.suggestIntervalMs('list_news', config.poll.news.min, config.poll.news.max);
    if (!this.ledger.canSpend('list_news')) return config.poll.news.max;

    const page = await this.jin10.listNews();
    const fresh = (page.items ?? []).filter((i) => !this.newsSeen.has(i.id));
    if (fresh.length) {
      for (const i of fresh) this.newsSeen.add(i.id);
      this.news.unshift(...fresh);
      this.news.splice(200);
      trim(this.newsSeen, 1000);
      this.bus.broadcast({ type: 'news', items: fresh, at: Date.now() });
    }
    this.lastError = null;
    return delay;
  }

  private async tickCalendar(): Promise<number> {
    if (this.idle()) return 10_000;
    const delay = this.ledger.suggestIntervalMs('list_calendar', config.poll.calendar.min, config.poll.calendar.max);
    if (!this.ledger.canSpend('list_calendar')) return config.poll.calendar.max;

    this.calendar = (await this.jin10.listCalendar()) ?? [];
    this.bus.broadcast({ type: 'calendar', events: this.calendar, at: Date.now() });
    this.lastError = null;
    return delay;
  }

  quotaSnapshot() {
    const p = config.poll;
    return this.ledger.snapshot([
      { tool: 'get_quote', intervalMs: this.ledger.suggestIntervalMs('get_quote', p.quote.min, p.quote.max) },
      { tool: 'get_kline', intervalMs: this.ledger.suggestIntervalMs('get_kline', p.kline.min, p.kline.max) },
      { tool: 'list_flash', intervalMs: this.ledger.suggestIntervalMs('list_flash', p.flash.min, p.flash.max) },
      { tool: 'list_news', intervalMs: this.ledger.suggestIntervalMs('list_news', p.news.min, p.news.max) },
      { tool: 'list_calendar', intervalMs: this.ledger.suggestIntervalMs('list_calendar', p.calendar.min, p.calendar.max) },
      { tool: 'search_flash', intervalMs: 0 },
      { tool: 'search_news', intervalMs: 0 },
      { tool: 'get_news', intervalMs: 0 },
    ]);
  }

  /**
   * 当前覆盖度 —— 前端把这些数字如实显示出来，不做"看起来很实时"的粉饰。
   *
   * 单品种刷新周期 = 总权重 / 合成调用速率 × (1/该品种权重)。
   */
  coverage() {
    const codes = this.targetCodes();
    const quoteMs = this.ledger.suggestIntervalMs('get_quote', config.poll.quote.min, config.poll.quote.max);
    const klineMs = this.ledger.suggestIntervalMs('get_kline', config.poll.kline.min, config.poll.kline.max);
    // 两条通道并行，合成调用速率取倒数之和
    const callsPerMs = 1 / quoteMs + 1 / klineMs;
    const totalWeight = codes.reduce((s, c) => s + weightOf(c), 0);
    const unit = totalWeight > 0 ? totalWeight / callsPerMs : 0;

    const coreWeights = codes.filter((c) => CORE_CODES.includes(c)).map(weightOf);
    const maxW = Math.max(1, ...coreWeights);

    return {
      scope: this.scope,
      codes: codes.length,
      coreCodes: CORE_CODES.length,
      /** 权重最高（核心锚）品种的刷新周期 */
      coreCycleMs: Math.round(unit / maxW),
      /** 权重为 1 的长尾品种的刷新周期 */
      cycleMs: Math.round(unit),
      quoteIntervalMs: quoteMs,
      klineIntervalMs: klineMs,
      /** 两条通道合计每天可用的调用次数 */
      dailyCalls: Math.round(86_400_000 * callsPerMs),
    };
  }
}

type PollKey = keyof typeof config.poll;

/** 冷启动冲刺的调用间隔。 */
const COLD_START_MS = 800;

/** 快讯去重键：线上不返回 id，退化用 url；url 也缺失时用时间+正文。 */
function flashKey(i: FlashItem): string {
  return i.id ?? i.url ?? `${i.time}|${i.content.slice(0, 40)}`;
}

/** 价格字符串的小数位，用来让重算出的涨跌额与原始精度一致。 */
function decimalsOf(price: string): number {
  const dot = price.indexOf('.');
  return dot === -1 ? 2 : Math.min(6, price.length - dot - 1);
}

function trim(set: Set<string>, max: number): void {
  if (set.size <= max) return;
  const drop = set.size - max;
  let n = 0;
  for (const v of set) {
    set.delete(v);
    if (++n >= drop) break;
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
