import { useEffect, useMemo, useState } from 'react';
import type { QuoteTick } from '../lib/useStream';
import { setScope, type Coverage, type UniverseMeta } from '../lib/api';
import { ago, fmtInterval, fmtPct, fmtPrice, sign } from '../lib/format';

interface Props {
  meta: UniverseMeta | null;
  quotes: Map<string, QuoteTick>;
  now: number;
  onPick: (code: string) => void;
}

type GroupBy = 'region' | 'asset';

interface Cell {
  code: string;
  label: string;
  region: string;
  asset: string;
  pct: number | null;
  price: string | null;
  at: number;
  tick?: QuoteTick;
}

interface Group {
  key: string;
  label: string;
  cells: Cell[];
  avg: number;
  up: number;
  down: number;
  covered: number;
}

/** 涨跌幅 → 色阶。用 |pct| 分五档，比线性插值更容易一眼分出强弱。 */
function heat(pct: number | null): { bg: string; border: string; cls: string } {
  if (pct === null || !Number.isFinite(pct)) {
    return { bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.07)', cls: 'flat' };
  }
  const a = Math.abs(pct);
  const step = a >= 3 ? 1 : a >= 1.5 ? 0.78 : a >= 0.7 ? 0.56 : a >= 0.25 ? 0.36 : 0.18;
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  if (dir === 'flat') return { bg: 'rgba(255,255,255,0.035)', border: 'rgba(255,255,255,0.08)', cls: 'flat' };
  return {
    bg: `color-mix(in srgb, var(--${dir}) ${Math.round(step * 26)}%, transparent)`,
    border: `color-mix(in srgb, var(--${dir}) ${Math.round(step * 55)}%, transparent)`,
    cls: dir,
  };
}

/** 中心发散条：正负从中线向两侧生长。 */
function DivergingBar({ value, max }: { value: number; max: number }) {
  const w = max > 0 ? Math.min(50, (Math.abs(value) / max) * 50) : 0;
  const up = value >= 0;
  return (
    <div className="dbar">
      <div className="dbar-axis" />
      <div
        className={`dbar-fill ${up ? 'up' : 'down'}`}
        style={up ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }}
      />
    </div>
  );
}

export function Overview({ meta, quotes, now, onPick }: Props) {
  const [groupBy, setGroupBy] = useState<GroupBy>('region');
  const [cov, setCov] = useState<Coverage | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (meta?.coverage) setCov(meta.coverage);
  }, [meta]);

  const flipScope = async () => {
    if (!cov || switching) return;
    setSwitching(true);
    try {
      setCov(await setScope(cov.scope === 'core' ? 'full' : 'core'));
    } catch {
      /* 保持原状 */
    } finally {
      setSwitching(false);
    }
  };

  const { groups, movers, breadth, maxAbsAvg, coveredAll, totalAll } = useMemo(() => {
    const instruments = meta?.instruments ?? [];
    const cells: Cell[] = instruments.map((i) => {
      const tick = quotes.get(i.code);
      const pct = tick ? Number(tick.quote.ups_percent) : null;
      return {
        code: i.code,
        label: tick?.quote.name || i.label,
        region: i.region,
        asset: i.asset,
        pct: pct !== null && Number.isFinite(pct) ? pct : null,
        price: tick ? tick.quote.close : null,
        at: tick?.at ?? 0,
        ...(tick ? { tick } : {}),
      };
    });

    const labels = groupBy === 'region' ? (meta?.regions ?? {}) : (meta?.assets ?? {});
    const byKey = new Map<string, Cell[]>();
    for (const c of cells) {
      const k = groupBy === 'region' ? c.region : c.asset;
      const arr = byKey.get(k);
      if (arr) arr.push(c);
      else byKey.set(k, [c]);
    }

    const gs: Group[] = [...byKey.entries()].map(([key, list]) => {
      const known = list.filter((c) => c.pct !== null);
      const avg = known.length ? known.reduce((s, c) => s + (c.pct ?? 0), 0) / known.length : 0;
      return {
        key,
        label: labels[key] ?? key,
        cells: [...list].sort((a, b) => (b.pct ?? -99) - (a.pct ?? -99)),
        avg,
        up: known.filter((c) => (c.pct ?? 0) > 0).length,
        down: known.filter((c) => (c.pct ?? 0) < 0).length,
        covered: known.length,
      };
    });
    gs.sort((a, b) => b.avg - a.avg);

    const known = cells.filter((c) => c.pct !== null);
    const sorted = [...known].sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));

    return {
      groups: gs,
      // 只收真正同向的品种：覆盖品种少或单边行情时，末尾 5 个可能全是上涨的
      movers: {
        top: sorted.filter((c) => (c.pct ?? 0) > 0).slice(0, 5),
        bottom: sorted
          .filter((c) => (c.pct ?? 0) < 0)
          .slice(-5)
          .reverse(),
      },
      breadth: {
        up: known.filter((c) => (c.pct ?? 0) > 0).length,
        down: known.filter((c) => (c.pct ?? 0) < 0).length,
        flat: known.filter((c) => (c.pct ?? 0) === 0).length,
      },
      maxAbsAvg: Math.max(0.1, ...gs.map((g) => Math.abs(g.avg))),
      coveredAll: known.length,
      totalAll: cells.length,
    };
  }, [meta, quotes, groupBy]);

  const breadthTotal = Math.max(1, breadth.up + breadth.down + breadth.flat);
  const bullPct = (breadth.up / breadthTotal) * 100;

  return (
    <div className="ov">
      {/* ── 顶部：市场宽度 + 覆盖度 ─────────────────────────── */}
      <section className="panel ov-top">
        <div className="ov-breadth">
          <div className="ov-breadth-head">
            <span className="panel-title">市场宽度</span>
            <span className="num" style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
              {coveredAll}/{totalAll} 已覆盖
            </span>
          </div>
          <div className="breadth-bar">
            <div className="breadth-seg up" style={{ width: `${(breadth.up / breadthTotal) * 100}%` }} />
            <div className="breadth-seg flat" style={{ width: `${(breadth.flat / breadthTotal) * 100}%` }} />
            <div className="breadth-seg down" style={{ width: `${(breadth.down / breadthTotal) * 100}%` }} />
          </div>
          <div className="breadth-legend">
            <span className="up num">▲ {breadth.up} 涨</span>
            <span className="flat num">— {breadth.flat} 平</span>
            <span className="down num">▼ {breadth.down} 跌</span>
            <span className="num" style={{ marginLeft: 'auto', color: bullPct >= 50 ? 'var(--up)' : 'var(--down)' }}>
              多头占比 {bullPct.toFixed(0)}%
            </span>
          </div>
        </div>

        <div className="ov-movers">
          <div className="mover-col">
            <label>领涨</label>
            {movers.top.map((c) => (
              <button key={c.code} className="mover" onClick={() => onPick(c.code)}>
                <span className="mover-name">{c.label}</span>
                <span className="num up">{fmtPct(c.pct)}</span>
              </button>
            ))}
            {!movers.top.length && <span className="mover-none">全线下跌</span>}
          </div>
          <div className="mover-col">
            <label>领跌</label>
            {movers.bottom.map((c) => (
              <button key={c.code} className="mover" onClick={() => onPick(c.code)}>
                <span className="mover-name">{c.label}</span>
                <span className="num down">{fmtPct(c.pct)}</span>
              </button>
            ))}
            {!movers.bottom.length && <span className="mover-none">全线上涨</span>}
          </div>
        </div>

        {cov && (
          <div className="ov-cov">
            <div className="stat">
              <label>覆盖品种</label>
              <b>{cov.codes}</b>
            </div>
            <div className="stat">
              <label>核心刷新</label>
              <b style={{ color: 'var(--gold)' }}>{fmtInterval(cov.coreCycleMs)}</b>
            </div>
            <div className="stat">
              <label>长尾刷新</label>
              <b>{fmtInterval(cov.cycleMs)}</b>
            </div>
            <div className="stat">
              <label>日调用预算</label>
              <b>{cov.dailyCalls}</b>
            </div>
            <div className="stat" style={{ alignSelf: 'center' }}>
              <button
                className={`chip${cov.scope === 'core' ? ' on' : ''}`}
                onClick={flipScope}
                disabled={switching}
                title={
                  cov.scope === 'core'
                    ? `只轮询核心 ${cov.coreCodes} 个品种，每个约 5 分钟刷新 —— 这是 24/7 额度下的理论上限`
                    : `覆盖全部 ${cov.codes} 个品种，核心更快、长尾更慢`
                }
              >
                {switching ? '切换中…' : cov.scope === 'core' ? `核心 ${cov.coreCodes} 品种` : `全部 ${cov.codes} 品种`}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ── 分组汇总条 ──────────────────────────────────────── */}
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">{groupBy === 'region' ? '按地区汇总' : '按品种汇总'}</span>
          <div className="tabs" style={{ marginLeft: 8 }}>
            <button className={`tab${groupBy === 'region' ? ' on' : ''}`} onClick={() => setGroupBy('region')}>
              地区
            </button>
            <button className={`tab${groupBy === 'asset' ? ' on' : ''}`} onClick={() => setGroupBy('asset')}>
              品种
            </button>
          </div>
          <span className="panel-sub">平均涨跌幅</span>
        </div>
        <div className="agg-list">
          {groups.map((g) => (
            <div className="agg-row" key={g.key}>
              <span className="agg-label">{g.label}</span>
              <DivergingBar value={g.avg} max={maxAbsAvg} />
              <span className={`num agg-val ${sign(g.avg)}`}>{fmtPct(g.avg)}</span>
              <span className="agg-breadth num">
                <i className="up">{g.up}</i>/<i className="down">{g.down}</i>
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ── 热力矩阵 ────────────────────────────────────────── */}
      <div className="ov-heat">
        {groups.map((g) => (
          <section className="panel" key={g.key}>
            <div className="panel-head">
              <span className="panel-title">{g.label}</span>
              <span className={`num ${sign(g.avg)}`} style={{ fontSize: 12, fontWeight: 650 }}>
                {fmtPct(g.avg)}
              </span>
              <span className="panel-sub">{g.covered}/{g.cells.length}</span>
            </div>
            <div className="heat-grid">
              {g.cells.map((c) => {
                const h = heat(c.pct);
                const stale = c.at > 0 && now - c.at > 15 * 60_000;
                return (
                  <button
                    key={c.code}
                    className={`heat-cell${c.pct === null ? ' pending' : ''}${stale ? ' stale' : ''}`}
                    style={{ background: h.bg, borderColor: h.border }}
                    onClick={() => onPick(c.code)}
                    title={`${c.label} (${c.code})${c.at ? ` · ${ago(c.at, now)}` : ''}`}
                  >
                    <span className="heat-name">{c.label}</span>
                    <span className={`heat-pct num ${h.cls}`}>{c.pct === null ? '—' : fmtPct(c.pct)}</span>
                    <span className="heat-price num">{c.price ? fmtPrice(c.price) : ''}</span>
                    {c.at > 0 && <span className="heat-age num">{ago(c.at, now)}</span>}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
