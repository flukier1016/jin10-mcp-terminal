import { memo } from 'react';
import type { QuoteTick } from '../lib/useStream';
import { ago, fmtPct, fmtPrice, sign } from '../lib/format';

interface Props {
  codes: string[];
  quotes: Map<string, QuoteTick>;
  active: string;
  now: number;
  onPick: (code: string) => void;
  onRemove: (code: string) => void;
}

function WatchlistInner({ codes, quotes, active, now, onPick, onRemove }: Props) {
  const lastAt = Math.max(0, ...[...quotes.values()].map((q) => q.at));

  return (
    <section className="panel watchlist-panel" style={{ flex: '0 1 auto' }}>
      <div className="panel-head">
        <span className="panel-title">自选行情</span>
        <span className="panel-sub">{lastAt ? ago(lastAt, now) : '等待数据'}</span>
      </div>
      <div className="panel-body">
        {codes.length === 0 && <div className="empty">暂无自选，点右上角「添加品种」</div>}
        {codes.map((code) => {
          const tick = quotes.get(code);
          const s = sign(tick?.quote.ups_percent);
          return (
            <div
              key={code}
              // seq 变化会让 React 重建节点，从而重放闪烁动画
              {...(tick ? { 'data-seq': tick.seq } : {})}
              className={`wl-row${code === active ? ' on' : ''}${tick && tick.dir !== 'flat' ? ` tick-${tick.dir}` : ''}`}
              onClick={() => onPick(code)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
                event.preventDefault();
                onPick(code);
              }}
              role="button"
              tabIndex={0}
              aria-pressed={code === active}
              aria-label={`${tick?.quote.name ?? code} ${tick ? `${fmtPrice(tick.quote.close)} ${fmtPct(tick.quote.ups_percent)}` : '等待数据'}`}
            >
              <div>
                <div className="wl-name">{tick?.quote.name ?? code}</div>
                <div className="wl-code">{code}</div>
              </div>
              <div>
                <div className={`wl-price ${s}`}>{tick ? fmtPrice(tick.quote.close) : <span className="skel" style={{ display: 'block', width: 54 }} />}</div>
                <div className={`wl-chg ${s}`}>{tick ? fmtPct(tick.quote.ups_percent) : ''}</div>
              </div>
              <button
                type="button"
                className="wl-del"
                title="移除"
                aria-label={`从自选移除 ${tick?.quote.name ?? code}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(code);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export const Watchlist = memo(WatchlistInner);
