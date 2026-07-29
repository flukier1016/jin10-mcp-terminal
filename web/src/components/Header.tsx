import { memo } from 'react';
import type { ConnState, QuotaSnapshot } from '../types';
import { bjTime, countdown, fmtInterval } from '../lib/format';
import { ExportMenu } from './ExportMenu';

const TOOL_LABEL: Record<string, string> = {
  get_quote: '行情',
  list_flash: '快讯',
  list_news: '资讯',
  list_calendar: '日历',
};

interface Props {
  conn: ConnState;
  quota: QuotaSnapshot | null;
  now: number;
  scheme: 'cn' | 'western';
  onScheme: () => void;
  theme: 'dark' | 'light';
  onTheme: () => void;
  onOpenCodes: () => void;
  /** 只有终端页需要"添加品种"。 */
  showCodes: boolean;
  wisburgOn: boolean;
  demo: boolean;
}

/** 顶栏：连接状态 + 额度水位 + 北京时间。额度直接摆出来，刷新节奏才是可信的。 */
function HeaderInner({
  conn,
  quota,
  now,
  scheme,
  onScheme,
  theme,
  onTheme,
  onOpenCodes,
  showCodes,
  wisburgOn,
  demo,
}: Props) {
  const polled = (quota?.tools ?? []).filter((t) => TOOL_LABEL[t.tool]);
  const statusLabel = demo
    ? 'DEMO'
    : conn === 'live'
      ? 'LIVE'
      : conn === 'connecting'
        ? 'CONNECTING'
        : 'RECONNECTING';

  return (
    <header className="header">
      <div className="brand">
        <div className="brand-mark">金</div>
        <div className="brand-text">
          <b>金十实时终端</b>
          <span>JIN10 · MCP TERMINAL</span>
        </div>
      </div>

      <div
        className={`live${demo ? ' demo' : conn === 'live' ? '' : conn === 'connecting' ? ' wait' : ' off'}`}
        role="status"
        aria-live="polite"
        title={demo ? '本地演示数据，不连接真实数据源' : '实时数据连接状态'}
      >
        <i className="dot" aria-hidden="true" />
        {statusLabel}
      </div>

      {polled.length > 0 && (
        <div
          className="quota"
          title={demo ? '演示模式额度仅用于验证界面' : '金十限制每个工具每天 1500 次调用，按北京时间自然日重置'}
          aria-label="数据工具额度"
        >
          {polled.map((t) => {
            const pct = Math.max(0, Math.min(100, (t.remaining / t.limit) * 100));
            return (
              <div className="quota-item" key={t.tool}>
                <label>
                  <span>{TOOL_LABEL[t.tool]}</span>
                  <span>{fmtInterval(t.intervalMs)}</span>
                </label>
                <div className="quota-bar">
                  <div className={`quota-fill${pct < 20 ? ' warn' : ''}`} style={{ width: `${pct}%` }} />
                </div>
                <label>
                  <span>{t.remaining}</span>
                  <span>/{t.limit}</span>
                </label>
              </div>
            );
          })}
          {quota && (
            <div className="quota-item" style={{ minWidth: 52 }}>
              <label>
                <span>重置</span>
              </label>
              <b className="num" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
                {countdown(quota.resetInMs)}
              </b>
            </div>
          )}
        </div>
      )}

      <div className="spacer" />

      <div className="header-actions" aria-label="终端操作">
        {showCodes && (
          <button type="button" className="chip" onClick={onOpenCodes}>
            ＋ 添加品种
          </button>
        )}
        <ExportMenu wisburgOn={wisburgOn} />
        <button
          type="button"
          className={`chip${scheme === 'cn' ? ' on' : ''}`}
          onClick={onScheme}
          title="切换涨跌配色"
          aria-pressed={scheme === 'cn'}
        >
          {scheme === 'cn' ? '红涨绿跌' : '绿涨红跌'}
        </button>
        <button
          type="button"
          className="chip theme-btn"
          onClick={onTheme}
          title={theme === 'dark' ? '切换到日间模式' : '切换到夜间模式'}
          aria-label={theme === 'dark' ? '切换到日间模式' : '切换到夜间模式'}
          aria-pressed={theme === 'light'}
        >
          {theme === 'dark' ? '☾ 夜间' : '☀ 日间'}
        </button>
      </div>

      <div className="clock">
        <b>{bjTime(now)}</b>
        <span>北京时间 UTC+8</span>
      </div>
    </header>
  );
}

export const Header = memo(HeaderInner);
