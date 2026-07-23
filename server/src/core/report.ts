import type { Scheduler } from './scheduler.js';
import { ASSET_LABEL, INSTRUMENT_BY_CODE, REGION_LABEL, UNIVERSE, type AssetClass, type Region } from './universe.js';
import type { CalendarEvent, FlashItem, NewsItem } from '../types.js';
import type { WisburgItem } from '../mcp/wisburg.js';

/**
 * 市场日报生成器。
 *
 * 数据全部取自调度器的内存快照 —— 生成报告本身**不产生任何金十调用**，
 * 因此可以随便点。只有勾选"含智堡研究"时才会多打 2 次智堡的工具调用。
 */

export interface QuoteRow {
  code: string;
  name: string;
  close: string;
  open: string;
  high: string;
  low: string;
  pct: number | null;
  delta: string;
  region: Region;
  asset: AssetClass;
  ageMs: number;
}

export interface GroupSummary {
  key: string;
  label: string;
  avg: number;
  up: number;
  down: number;
  rows: QuoteRow[];
}

export interface ReportData {
  generatedAt: string;
  bjStamp: string;
  coverage: ReturnType<Scheduler['coverage']>;
  breadth: { up: number; down: number; flat: number; total: number; bullPct: number };
  regions: GroupSummary[];
  assets: GroupSummary[];
  movers: { top: QuoteRow[]; bottom: QuoteRow[] };
  calendar: { released: CalendarEvent[]; upcoming: CalendarEvent[] };
  flashes: FlashItem[];
  news: NewsItem[];
  research?: { feed: WisburgItem[]; daily: WisburgItem[] };
}

export interface ReportOptions {
  /** 快讯条数上限 */
  flashLimit?: number;
  /** 资讯条数上限 */
  newsLimit?: number;
  /** 日历只保留几星以上 */
  minStar?: number;
}

const BJ_OFFSET = 8 * 3600 * 1000;

/** "2026-07-23 14:45"（北京时间）→ 毫秒时间戳。 */
function parseBj(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s);
  if (!m) return NaN;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]! - 8, +m[5]!);
}

export function bjStamp(ts = Date.now()): string {
  return new Date(ts + BJ_OFFSET).toISOString().replace('T', ' ').slice(0, 19);
}

export function bjFileStamp(ts = Date.now()): string {
  return new Date(ts + BJ_OFFSET).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
}

export function buildReport(scheduler: Scheduler, opts: ReportOptions = {}): ReportData {
  const now = Date.now();
  const flashLimit = opts.flashLimit ?? 40;
  const newsLimit = opts.newsLimit ?? 10;
  const minStar = opts.minStar ?? 0;

  const rows: QuoteRow[] = [];
  for (const inst of UNIVERSE) {
    const snap = scheduler.quotes.get(inst.code);
    if (!snap) continue;
    const q = snap.quote;
    const pct = Number(q.ups_percent);
    rows.push({
      code: inst.code,
      name: q.name || inst.label,
      close: q.close,
      open: q.open,
      high: q.high,
      low: q.low,
      pct: Number.isFinite(pct) ? pct : null,
      delta: q.ups_price,
      region: inst.region,
      asset: inst.asset,
      ageMs: now - snap.at,
    });
  }

  const known = rows.filter((r) => r.pct !== null);
  const up = known.filter((r) => (r.pct ?? 0) > 0).length;
  const down = known.filter((r) => (r.pct ?? 0) < 0).length;
  const flat = known.length - up - down;

  const group = <K extends string>(pick: (r: QuoteRow) => K, labels: Record<string, string>): GroupSummary[] => {
    const map = new Map<string, QuoteRow[]>();
    for (const r of rows) {
      const k = pick(r);
      const arr = map.get(k);
      if (arr) arr.push(r);
      else map.set(k, [r]);
    }
    return [...map.entries()]
      .map(([key, list]) => {
        const k = list.filter((r) => r.pct !== null);
        return {
          key,
          label: labels[key] ?? key,
          avg: k.length ? k.reduce((s, r) => s + (r.pct ?? 0), 0) / k.length : 0,
          up: k.filter((r) => (r.pct ?? 0) > 0).length,
          down: k.filter((r) => (r.pct ?? 0) < 0).length,
          rows: [...list].sort((a, b) => (b.pct ?? -99) - (a.pct ?? -99)),
        };
      })
      .sort((a, b) => b.avg - a.avg);
  };

  const sorted = [...known].sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));

  // 日历：只取今天，按已公布 / 待公布分开
  const todayBj = bjStamp(now).slice(0, 10);
  const today = scheduler.calendar
    .filter((e) => e.pub_time.slice(0, 10) === todayBj && e.star >= minStar)
    .sort((a, b) => parseBj(a.pub_time) - parseBj(b.pub_time));

  return {
    generatedAt: new Date(now).toISOString(),
    bjStamp: bjStamp(now),
    coverage: scheduler.coverage(),
    breadth: {
      up,
      down,
      flat,
      total: known.length,
      bullPct: known.length ? (up / known.length) * 100 : 0,
    },
    regions: group((r) => r.region, REGION_LABEL),
    assets: group((r) => r.asset, ASSET_LABEL),
    // 领涨/领跌只收真正同向的品种：覆盖品种少时，末尾 5 个可能全是上涨的
    movers: {
      top: sorted.filter((r) => (r.pct ?? 0) > 0).slice(0, 5),
      bottom: sorted
        .filter((r) => (r.pct ?? 0) < 0)
        .slice(-5)
        .reverse(),
    },
    calendar: {
      released: today.filter((e) => e.actual !== null && e.actual !== ''),
      upcoming: today.filter((e) => e.actual === null || e.actual === ''),
    },
    flashes: scheduler.flashes.slice(0, flashLimit),
    news: scheduler.news.slice(0, newsLimit),
  };
}

// ── 渲染 ────────────────────────────────────────────────────────

const pct = (v: number | null): string => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const arrow = (v: number | null): string => (v === null ? '·' : v > 0 ? '▲' : v < 0 ? '▼' : '—');
const dash = (v: string | null | undefined): string => (v === null || v === undefined || v === '' ? '—' : v);
const hm = (iso: string): string => bjStamp(new Date(iso).getTime()).slice(11, 16);
const stars = (n: number): string => '★'.repeat(Math.max(0, Math.min(5, n)));

function ageText(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  return `${Math.floor(s / 3600)}小时前`;
}

/** Markdown —— 可直接粘进微信/邮件/笔记。 */
export function renderMarkdown(d: ReportData): string {
  const L: string[] = [];

  L.push(`# 市场日报 · ${d.bjStamp.slice(0, 10)}`);
  L.push('');
  L.push(`> 生成时间：${d.bjStamp}（北京时间）`);
  L.push(`> 数据来源：金十数据 MCP${d.research ? ' · 智堡 Wisburg MCP' : ''}`);
  L.push(
    `> 覆盖 ${d.coverage.codes} 个品种，核心刷新 ${Math.round(d.coverage.coreCycleMs / 60000)} 分钟 / 长尾 ${Math.round(d.coverage.cycleMs / 60000)} 分钟`,
  );
  L.push('');

  L.push('## 一、市场概况');
  L.push('');
  L.push(
    `**涨跌分布**：${d.breadth.up} 涨 / ${d.breadth.flat} 平 / ${d.breadth.down} 跌（共 ${d.breadth.total} 个品种），多头占比 **${d.breadth.bullPct.toFixed(0)}%**`,
  );
  L.push('');

  L.push('### 按地区');
  L.push('');
  L.push('| 地区 | 平均涨跌 | 涨 | 跌 |');
  L.push('| --- | ---: | ---: | ---: |');
  for (const g of d.regions) L.push(`| ${g.label} | ${arrow(g.avg)} ${pct(g.avg)} | ${g.up} | ${g.down} |`);
  L.push('');

  L.push('### 按品种');
  L.push('');
  L.push('| 资产类别 | 平均涨跌 | 涨 | 跌 |');
  L.push('| --- | ---: | ---: | ---: |');
  for (const g of d.assets) L.push(`| ${g.label} | ${arrow(g.avg)} ${pct(g.avg)} | ${g.up} | ${g.down} |`);
  L.push('');

  L.push('### 领涨 / 领跌');
  L.push('');
  L.push('| | 品种 | 最新价 | 涨跌幅 |');
  L.push('| --- | --- | ---: | ---: |');
  for (const r of d.movers.top) L.push(`| 涨 | ${r.name} | ${r.close} | **${pct(r.pct)}** |`);
  for (const r of d.movers.bottom) L.push(`| 跌 | ${r.name} | ${r.close} | **${pct(r.pct)}** |`);
  L.push('');

  L.push('## 二、行情明细');
  L.push('');
  for (const g of d.regions) {
    if (!g.rows.length) continue;
    L.push(`### ${g.label}　${arrow(g.avg)} ${pct(g.avg)}`);
    L.push('');
    L.push('| 品种 | 代码 | 最新 | 今开 | 最高 | 最低 | 涨跌 | 幅度 | 更新 |');
    L.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const r of g.rows) {
      L.push(
        `| ${r.name} | \`${r.code}\` | ${r.close} | ${r.open} | ${r.high} | ${r.low} | ${r.delta} | ${pct(r.pct)} | ${ageText(r.ageMs)} |`,
      );
    }
    L.push('');
  }

  L.push('## 三、今日财经日历');
  L.push('');
  if (!d.calendar.released.length && !d.calendar.upcoming.length) {
    L.push('_今日无数据_');
    L.push('');
  } else {
    if (d.calendar.released.length) {
      L.push('### 已公布');
      L.push('');
      L.push('| 时间 | 重要性 | 指标 | 前值 | 预期 | 公布 | 影响 |');
      L.push('| --- | --- | --- | ---: | ---: | ---: | --- |');
      for (const e of d.calendar.released) {
        L.push(
          `| ${e.pub_time.slice(11, 16)} | ${stars(e.star)} | ${e.title} | ${dash(e.revised ?? e.previous)} | ${dash(e.consensus)} | **${dash(e.actual)}** | ${e.affect_txt || '—'} |`,
        );
      }
      L.push('');
    }
    if (d.calendar.upcoming.length) {
      L.push('### 待公布');
      L.push('');
      L.push('| 时间 | 重要性 | 指标 | 前值 | 预期 |');
      L.push('| --- | --- | --- | ---: | ---: |');
      for (const e of d.calendar.upcoming) {
        L.push(
          `| ${e.pub_time.slice(11, 16)} | ${stars(e.star)} | ${e.title} | ${dash(e.revised ?? e.previous)} | ${dash(e.consensus)} |`,
        );
      }
      L.push('');
    }
  }

  L.push('## 四、重要快讯');
  L.push('');
  for (const f of d.flashes) L.push(`- \`${hm(f.time)}\` ${f.content}`);
  if (!d.flashes.length) L.push('_暂无_');
  L.push('');

  if (d.news.length) {
    L.push('## 五、深度资讯');
    L.push('');
    for (const n of d.news) {
      L.push(`- **[${n.title}](${n.url})**　\`${hm(n.time)}\``);
      if (n.introduction) L.push(`  ${n.introduction}`);
    }
    L.push('');
  }

  if (d.research) {
    L.push('## 六、智堡研究');
    L.push('');
    if (d.research.daily.length) {
      L.push('### 市场日报');
      L.push('');
      for (const i of d.research.daily) L.push(`- **${i.title}**　\`${hm(i.time)}\``);
      L.push('');
    }
    if (d.research.feed.length) {
      L.push('### 投研资讯流');
      L.push('');
      for (const i of d.research.feed) {
        L.push(`- **${i.title}**　\`${hm(i.time)}\``);
        if (i.summary) L.push(`  ${i.summary.replace(/\n+/g, ' ').slice(0, 220)}`);
      }
      L.push('');
    }
  }

  L.push('---');
  L.push('');
  L.push(`_由 金十实时终端 生成 · ${d.bjStamp} · 数据仅供参考，不构成投资建议_`);
  L.push('');
  return L.join('\n');
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 自包含 HTML —— 浏览器直接打开即可打印成 PDF，样式按 A4 排版。 */
export function renderHtml(d: ReportData): string {
  const cls = (v: number | null) => (v === null ? 'flat' : v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
  const cell = (v: number | null) => `<td class="n ${cls(v)}"><b>${pct(v)}</b></td>`;

  const groupTable = (list: GroupSummary[], head: string) => `
    <table class="sum">
      <thead><tr><th>${head}</th><th class="n">平均涨跌</th><th class="n">涨</th><th class="n">跌</th><th>分布</th></tr></thead>
      <tbody>
      ${list
        .map((g) => {
          const total = Math.max(1, g.up + g.down);
          return `<tr>
            <td>${esc(g.label)}</td>
            ${cell(g.avg)}
            <td class="n up">${g.up}</td>
            <td class="n down">${g.down}</td>
            <td class="bar"><span class="bar-up" style="width:${(g.up / total) * 100}%"></span><span class="bar-down" style="width:${(g.down / total) * 100}%"></span></td>
          </tr>`;
        })
        .join('')}
      </tbody>
    </table>`;

  const quoteTables = d.regions
    .filter((g) => g.rows.length)
    .map(
      (g) => `
    <h3>${esc(g.label)} <span class="tag ${cls(g.avg)}">${pct(g.avg)}</span></h3>
    <table>
      <thead><tr><th>品种</th><th>代码</th><th class="n">最新</th><th class="n">今开</th><th class="n">最高</th><th class="n">最低</th><th class="n">涨跌</th><th class="n">幅度</th><th class="n">更新</th></tr></thead>
      <tbody>
      ${g.rows
        .map(
          (r) => `<tr>
          <td>${esc(r.name)}</td><td class="code">${esc(r.code)}</td>
          <td class="n b">${esc(r.close)}</td><td class="n">${esc(r.open)}</td>
          <td class="n up">${esc(r.high)}</td><td class="n down">${esc(r.low)}</td>
          <td class="n ${cls(r.pct)}">${esc(r.delta)}</td>${cell(r.pct)}
          <td class="n dim">${ageText(r.ageMs)}</td>
        </tr>`,
        )
        .join('')}
      </tbody>
    </table>`,
    )
    .join('');

  const calRows = (list: CalendarEvent[], withActual: boolean) =>
    list
      .map(
        (e) => `<tr>
      <td class="n">${e.pub_time.slice(11, 16)}</td>
      <td class="star">${stars(e.star)}</td>
      <td>${esc(e.title)}</td>
      <td class="n">${esc(dash(e.revised ?? e.previous))}</td>
      <td class="n">${esc(dash(e.consensus))}</td>
      ${withActual ? `<td class="n b">${esc(dash(e.actual))}</td><td>${e.affect_txt ? `<span class="tag ${e.affect_txt === '利多' ? 'up' : 'down'}">${esc(e.affect_txt)}</span>` : ''}</td>` : ''}
    </tr>`,
      )
      .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>市场日报 ${d.bjStamp.slice(0, 10)} · 金十实时终端</title>
<style>
  :root{--fg:#14181f;--dim:#5c6473;--mute:#8b93a2;--line:#dfe4ec;--bg:#fff;--panel:#f7f9fc;
        --up:#d81e3c;--down:#06865c;--flat:#8b93a2;--gold:#a86a06}
  *{box-sizing:border-box}
  body{margin:0;padding:32px 28px 60px;background:var(--bg);color:var(--fg);
       font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
       max-width:1080px;margin-inline:auto;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  h1{font-size:26px;margin:0 0 4px;letter-spacing:-.01em}
  h2{font-size:17px;margin:34px 0 12px;padding-bottom:7px;border-bottom:2px solid var(--fg)}
  h3{font-size:14px;margin:20px 0 8px;color:var(--dim);display:flex;align-items:center;gap:8px}
  .meta{color:var(--dim);font-size:12px;margin-bottom:6px}
  .meta code{background:var(--panel);padding:1px 5px;border-radius:4px;font-size:11px}
  .n{font-variant-numeric:tabular-nums;text-align:right;
     font-family:ui-monospace,"SF Mono",Menlo,monospace}
  .b{font-weight:650}
  .dim{color:var(--mute);font-size:11px}
  .code{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--mute)}
  .up{color:var(--up)}.down{color:var(--down)}.flat{color:var(--flat)}
  .star{color:var(--gold);font-size:10px;letter-spacing:-1px;white-space:nowrap}
  table{width:100%;border-collapse:collapse;margin-bottom:14px;font-size:12.5px}
  th{text-align:left;font-size:10.5px;letter-spacing:.06em;color:var(--mute);
     font-weight:600;padding:6px 8px;border-bottom:1px solid var(--line);text-transform:uppercase}
  th.n{text-align:right}
  td{padding:5px 8px;border-bottom:1px solid var(--line)}
  tbody tr:nth-child(even){background:var(--panel)}
  .sum td:first-child{font-weight:600}
  .bar{width:130px}
  .bar span{display:inline-block;height:9px;border-radius:2px;vertical-align:middle}
  .bar-up{background:var(--up)}.bar-down{background:var(--down)}
  .tag{display:inline-block;padding:1px 7px;border-radius:5px;font-size:11px;font-weight:600;
       background:var(--panel);border:1px solid var(--line)}
  .tag.up{color:var(--up);border-color:var(--up)}
  .tag.down{color:var(--down);border-color:var(--down)}
  .hero{display:flex;gap:26px;flex-wrap:wrap;padding:16px 18px;background:var(--panel);
        border:1px solid var(--line);border-radius:12px;margin:16px 0 8px}
  .hero div{min-width:88px}
  .hero label{display:block;font-size:10px;letter-spacing:.09em;color:var(--mute);margin-bottom:3px}
  .hero b{font-size:20px;font-variant-numeric:tabular-nums;
          font-family:ui-monospace,Menlo,monospace;letter-spacing:-.02em}
  ul{padding-left:0;list-style:none;margin:0}
  li{padding:6px 0 6px 62px;border-bottom:1px solid var(--line);position:relative;font-size:13px}
  li time{position:absolute;left:0;top:6px;font-family:ui-monospace,Menlo,monospace;
          font-size:11px;color:var(--mute)}
  li p{margin:3px 0 0;color:var(--dim);font-size:12px}
  footer{margin-top:38px;padding-top:14px;border-top:1px solid var(--line);
         color:var(--mute);font-size:11px;text-align:center}
  .print{position:fixed;top:16px;right:16px;padding:8px 16px;border-radius:8px;border:1px solid var(--line);
         background:#fff;font-size:13px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.08)}
  .print:hover{background:var(--panel)}
  @media print{
    body{padding:0;font-size:11px}
    .print{display:none}
    h2{margin-top:18px;page-break-after:avoid}
    h3{page-break-after:avoid}
    table{page-break-inside:auto;font-size:10px}
    tr{page-break-inside:avoid}
    thead{display:table-header-group}
    @page{margin:14mm 12mm;size:A4}
  }
</style>
</head>
<body>
<button class="print" onclick="window.print()">🖨 打印 / 存为 PDF</button>

<h1>市场日报 · ${d.bjStamp.slice(0, 10)}</h1>
<div class="meta">生成于 <code>${d.bjStamp}</code> 北京时间　·　数据来源：金十数据 MCP${d.research ? ' · 智堡 Wisburg MCP' : ''}</div>
<div class="meta">覆盖 ${d.coverage.codes} 个品种　·　核心刷新 ${Math.round(d.coverage.coreCycleMs / 60000)} 分钟　·　长尾刷新 ${Math.round(d.coverage.cycleMs / 60000)} 分钟　·　日调用预算 ${d.coverage.dailyCalls}</div>

<div class="hero">
  <div><label>上涨</label><b class="up">${d.breadth.up}</b></div>
  <div><label>下跌</label><b class="down">${d.breadth.down}</b></div>
  <div><label>持平</label><b class="flat">${d.breadth.flat}</b></div>
  <div><label>多头占比</label><b class="${d.breadth.bullPct >= 50 ? 'up' : 'down'}">${d.breadth.bullPct.toFixed(0)}%</b></div>
  <div><label>覆盖品种</label><b>${d.breadth.total}</b></div>
</div>

<h2>一、市场概况</h2>
<h3>按地区</h3>
${groupTable(d.regions, '地区')}
<h3>按品种</h3>
${groupTable(d.assets, '资产类别')}

<h3>领涨 / 领跌</h3>
<table>
  <thead><tr><th></th><th>品种</th><th>代码</th><th class="n">最新价</th><th class="n">涨跌幅</th></tr></thead>
  <tbody>
  ${d.movers.top.map((r) => `<tr><td class="up">▲</td><td>${esc(r.name)}</td><td class="code">${esc(r.code)}</td><td class="n b">${esc(r.close)}</td>${cell(r.pct)}</tr>`).join('')}
  ${d.movers.bottom.map((r) => `<tr><td class="down">▼</td><td>${esc(r.name)}</td><td class="code">${esc(r.code)}</td><td class="n b">${esc(r.close)}</td>${cell(r.pct)}</tr>`).join('')}
  </tbody>
</table>

<h2>二、行情明细</h2>
${quoteTables}

<h2>三、今日财经日历</h2>
${
  d.calendar.released.length
    ? `<h3>已公布</h3>
<table>
  <thead><tr><th class="n">时间</th><th>重要性</th><th>指标</th><th class="n">前值</th><th class="n">预期</th><th class="n">公布</th><th>影响</th></tr></thead>
  <tbody>${calRows(d.calendar.released, true)}</tbody>
</table>`
    : ''
}
${
  d.calendar.upcoming.length
    ? `<h3>待公布</h3>
<table>
  <thead><tr><th class="n">时间</th><th>重要性</th><th>指标</th><th class="n">前值</th><th class="n">预期</th></tr></thead>
  <tbody>${calRows(d.calendar.upcoming, false)}</tbody>
</table>`
    : ''
}
${!d.calendar.released.length && !d.calendar.upcoming.length ? '<p class="dim">今日无日历数据。</p>' : ''}

<h2>四、重要快讯</h2>
<ul>
${d.flashes.map((f) => `<li><time>${hm(f.time)}</time>${esc(f.content)}</li>`).join('')}
${!d.flashes.length ? '<li class="dim">暂无</li>' : ''}
</ul>

${
  d.news.length
    ? `<h2>五、深度资讯</h2>
<ul>
${d.news.map((n) => `<li><time>${hm(n.time)}</time><b>${esc(n.title)}</b>${n.introduction ? `<p>${esc(n.introduction)}</p>` : ''}</li>`).join('')}
</ul>`
    : ''
}

${
  d.research
    ? `<h2>${d.news.length ? '六' : '五'}、智堡研究</h2>
${
  d.research.daily.length
    ? `<h3>市场日报</h3><ul>${d.research.daily.map((i) => `<li><time>${hm(i.time)}</time><b>${esc(i.title)}</b></li>`).join('')}</ul>`
    : ''
}
${
  d.research.feed.length
    ? `<h3>投研资讯流</h3><ul>${d.research.feed.map((i) => `<li><time>${hm(i.time)}</time><b>${esc(i.title)}</b>${i.summary ? `<p>${esc(i.summary.replace(/\n+/g, ' ').slice(0, 260))}</p>` : ''}</li>`).join('')}</ul>`
    : ''
}`
    : ''
}

<footer>由 金十实时终端 · JIN10 MCP TERMINAL 生成　·　${d.bjStamp}<br>数据仅供参考，不构成投资建议</footer>
</body>
</html>`;
}
