import { memo } from 'react';
import type { QuoteTick } from '../lib/useStream';
import { ago, fmtDelta, fmtPct, fmtPrice, fmtVolume, sign } from '../lib/format';

interface Props {
  code: string;
  tick?: QuoteTick;
  now: number;
}

function HeroInner({ code, tick, now }: Props) {
  const q = tick?.quote;
  const s = sign(q?.ups_percent);

  return (
    <div className="hero">
      <div className="hero-id">
        <b>{q?.name ?? code}</b>
        <span>{code}</span>
      </div>

      <div
        key={tick?.seq}
        className={`hero-price ${s}${tick && tick.dir !== 'flat' ? ` tick-${tick.dir}` : ''}`}
        style={{ borderRadius: 8, padding: '0 4px', margin: '0 -4px' }}
      >
        {q ? fmtPrice(q.close) : '—'}
      </div>

      <div className={`hero-chg ${s}`}>
        <span>{q ? fmtDelta(q.ups_price) : '—'}</span>
        <span>{q ? fmtPct(q.ups_percent) : '—'}</span>
      </div>

      <div className="hero-stats">
        <div className="stat">
          <label>今开</label>
          <b>{fmtPrice(q?.open)}</b>
        </div>
        <div className="stat">
          <label>最高</label>
          <b className="up">{fmtPrice(q?.high)}</b>
        </div>
        <div className="stat">
          <label>最低</label>
          <b className="down">{fmtPrice(q?.low)}</b>
        </div>
        <div className="stat">
          <label>成交量</label>
          <b>{fmtVolume(q?.volume)}</b>
        </div>
        <div className="stat">
          <label>更新</label>
          <b style={{ color: 'var(--fg-dim)' }}>{tick ? ago(tick.at, now) : '—'}</b>
        </div>
      </div>
    </div>
  );
}

export const Hero = memo(HeroInner);
