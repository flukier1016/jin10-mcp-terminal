import { useEffect, useMemo, useRef } from 'react';
import type { CalendarEvent } from '../types';
import { dash } from '../lib/format';

interface Props {
  events: CalendarEvent[];
  now: number;
}

/** "2026-07-20 06:45" 是北京时间字符串，直接按本地字段解析避免时区二次偏移。 */
function parseBj(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s);
  if (!m) return NaN;
  const [, y, mo, d, h, mi] = m;
  return Date.UTC(+y!, +mo! - 1, +d!, +h! - 8, +mi!);
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function CalendarPanel({ events, now }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);

  const { rows, nextIdx } = useMemo(() => {
    const sorted = [...events].sort((a, b) => parseBj(a.pub_time) - parseBj(b.pub_time));
    const idx = sorted.findIndex((e) => parseBj(e.pub_time) > now);
    return { rows: sorted, nextIdx: idx };
  }, [events, now]);

  // 本周数据从周一开始，但用户真正关心的是"下一个待公布"，首次渲染时滚过去
  useEffect(() => {
    if (scrolled.current || !nextRef.current || !bodyRef.current) return;
    scrolled.current = true;
    const top = nextRef.current.offsetTop - bodyRef.current.offsetTop - 60;
    bodyRef.current.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [nextIdx]);

  let lastDay = '';

  return (
    <>
      <div className="panel-body" ref={bodyRef}>
        <div className="cal-row head">
          <span>时间</span>
          <span>重要性</span>
          <span>指标</span>
          <span style={{ textAlign: 'right' }}>前值</span>
          <span style={{ textAlign: 'right' }}>预期</span>
          <span style={{ textAlign: 'right' }}>公布</span>
        </div>

        {!rows.length && <div className="empty">暂无日历数据</div>}

        {rows.map((e, i) => {
          const t = parseBj(e.pub_time);
          const day = e.pub_time.slice(0, 10);
          const showDay = day !== lastDay;
          lastDay = day;
          const past = t <= now;
          const bull = e.affect_txt === '利多';
          const bear = e.affect_txt === '利空';

          return (
            <div key={`${e.pub_time}-${e.title}-${i}`}>
              {showDay && (
                <div
                  style={{
                    padding: '7px 13px 4px',
                    fontSize: 10.5,
                    letterSpacing: '0.08em',
                    color: 'var(--fg-mute)',
                    fontFamily: 'var(--mono)',
                    background: 'rgba(0,0,0,0.22)',
                  }}
                >
                  {day.slice(5).replace('-', '月')}日 · {WEEK[new Date(t).getUTCDay()] ?? ''}
                </div>
              )}
              <div
                ref={i === nextIdx ? nextRef : undefined}
                className={`cal-row${past ? ' done' : ''}${i === nextIdx ? ' next' : ''}`}
              >
                <span className="cal-time">{e.pub_time.slice(11, 16)}</span>
                <span className="stars" title={`重要性 ${e.star}/5`}>
                  {'★'.repeat(Math.max(0, Math.min(5, e.star)))}
                  <span style={{ color: 'var(--fg-mute)', opacity: 0.4 }}>
                    {'★'.repeat(Math.max(0, 5 - e.star))}
                  </span>
                </span>
                <span className="cal-title" title={e.title}>
                  {e.title}
                  {bull && <i className="tag bull">利多</i>}
                  {bear && <i className="tag bear">利空</i>}
                </span>
                <span className="cal-val">{dash(e.revised ?? e.previous)}</span>
                <span className="cal-val">{dash(e.consensus)}</span>
                <span className="cal-val actual">{dash(e.actual)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
