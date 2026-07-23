import { useCallback, useEffect, useMemo, useState } from 'react';
import { Header } from './components/Header';
import { Sidebar, type View } from './components/Sidebar';
import { Watchlist } from './components/Watchlist';
import { Hero } from './components/Hero';
import { Chart } from './components/Chart';
import { FlashFeed } from './components/FlashFeed';
import { NewsPanel } from './components/NewsPanel';
import { CalendarPanel } from './components/CalendarPanel';
import { CodePicker } from './components/CodePicker';
import { ArticleModal } from './components/ArticleModal';
import { Overview } from './components/Overview';
import { Research, ResearchModal } from './components/Research';
import { useNow, useStream } from './lib/useStream';
import { api, type UniverseMeta } from './lib/api';
import type { KlineBar } from './types';

const DEFAULT_WATCH = ['XAUUSD', 'XAGUSD', 'USOIL', 'UKOIL', 'USDCNH', 'USDJPY', 'EURUSD', 'COPPER'];
const LS_WATCH = 'jin10.watchlist';
const LS_SCHEME = 'jin10.scheme';
const LS_VIEW = 'jin10.view';
const LS_THEME = 'jin10.theme';

/** 首次访问跟随系统的深色偏好，之后以用户显式选择为准。 */
function initialTheme(): 'dark' | 'light' {
  const saved = localStorage.getItem(LS_THEME);
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function loadWatch(): string[] {
  try {
    const raw = localStorage.getItem(LS_WATCH);
    const arr = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(arr) && arr.length && arr.every((x) => typeof x === 'string')) return arr as string[];
  } catch {
    /* 存储损坏就回退默认 */
  }
  return DEFAULT_WATCH;
}

export default function App() {
  const [view, setView] = useState<View>(() => (localStorage.getItem(LS_VIEW) as View) ?? 'terminal');
  const [watch, setWatch] = useState<string[]>(loadWatch);
  const [active, setActive] = useState<string>(() => loadWatch()[0] ?? 'XAUUSD');
  const [scheme, setScheme] = useState<'cn' | 'western'>(
    () => (localStorage.getItem(LS_SCHEME) as 'cn' | 'western') ?? 'cn',
  );
  const [theme, setTheme] = useState<'dark' | 'light'>(initialTheme);
  const [tab, setTab] = useState<'calendar' | 'news'>('calendar');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [articleId, setArticleId] = useState<string | null>(null);
  const [resTarget, setResTarget] = useState<{ kind: 'article' | 'report'; id: string; category?: string } | null>(null);

  const [meta, setMeta] = useState<UniverseMeta | null>(null);
  const [bars, setBars] = useState<KlineBar[]>([]);
  const [barsLoading, setBarsLoading] = useState(false);

  const now = useNow();

  // 订阅 = 自选 ∪ 总览宇宙。服务端本来就 24/7 覆盖宇宙，
  // 这里把它们都订上，切到总览页时热力图立刻是满的，不用等。
  const subscribe = useMemo(() => {
    const uni = meta?.instruments.map((i) => i.code) ?? [];
    return [...new Set([...watch, ...uni])];
  }, [watch, meta]);

  const stream = useStream(subscribe, active);

  useEffect(() => {
    const ac = new AbortController();
    api
      .universe(ac.signal)
      .then(setMeta)
      .catch(() => undefined);
    return () => ac.abort();
  }, []);

  useEffect(() => localStorage.setItem(LS_WATCH, JSON.stringify(watch)), [watch]);
  useEffect(() => localStorage.setItem(LS_VIEW, view), [view]);
  useEffect(() => {
    localStorage.setItem(LS_SCHEME, scheme);
    document.documentElement.dataset.scheme = scheme === 'western' ? 'western' : 'cn';
  }, [scheme]);

  useEffect(() => {
    localStorage.setItem(LS_THEME, theme);
    document.documentElement.dataset.theme = theme;
    // 移动端地址栏跟着主题走
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#eef1f6' : '#05070c');
  }, [theme]);

  // 切换品种先用 REST 抢一次首屏（服务端有缓存，通常不产生真实调用），
  // 之后交给 SSE 的 kline 推送持续更新 —— 不再做客户端定时轮询。
  useEffect(() => {
    if (!active || view !== 'terminal') return;
    let alive = true;
    const ac = new AbortController();
    setBars([]);
    setBarsLoading(true);
    api
      .kline(active, 100, ac.signal)
      .then((s) => alive && setBars(s.klines ?? []))
      .catch(() => undefined)
      .finally(() => alive && setBarsLoading(false));
    return () => {
      alive = false;
      ac.abort();
    };
  }, [active, view]);

  useEffect(() => {
    if (stream.kline && stream.kline.code === active && stream.kline.bars.length) {
      setBars(stream.kline.bars);
      setBarsLoading(false);
    }
  }, [stream.kline, active]);

  const tick = stream.quotes.get(active);
  // 最后一根分钟线的收盘价往往比 get_quote 的快照更新，取两者里较新的那个
  const lastBarClose = bars.length ? Number(bars[bars.length - 1]!.close) : undefined;
  const quoteAt = tick?.at ?? 0;
  const klineAt = stream.kline?.code === active ? stream.kline.at : 0;
  const livePrice = klineAt > quoteAt && lastBarClose ? lastBarClose : tick ? Number(tick.quote.close) : lastBarClose;

  const toggleCode = useCallback((code: string) => {
    setWatch((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  }, []);

  const removeCode = useCallback(
    (code: string) => {
      setWatch((prev) => {
        const next = prev.filter((c) => c !== code);
        if (code === active) setActive(next[0] ?? '');
        return next;
      });
    },
    [active],
  );

  /** 从总览点进某个品种 → 加进自选并跳回终端页 */
  const pickFromOverview = useCallback((code: string) => {
    setWatch((prev) => (prev.includes(code) ? prev : [...prev, code]));
    setActive(code);
    setView('terminal');
  }, []);

  return (
    <div className="app">
      <Header
        conn={stream.conn}
        quota={stream.quota}
        now={now}
        scheme={scheme}
        onScheme={() => setScheme((s) => (s === 'cn' ? 'western' : 'cn'))}
        theme={theme}
        onTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onOpenCodes={() => setPickerOpen(true)}
        showCodes={view === 'terminal'}
        wisburgOn={meta?.sources.wisburg ?? false}
      />

      <div className="shell">
        <Sidebar view={view} onView={setView} wisburgOn={meta?.sources.wisburg ?? false} />

        {view === 'terminal' && (
          <div className="grid">
            <div className="col">
              <Watchlist
                codes={watch}
                quotes={stream.quotes}
                active={active}
                now={now}
                onPick={setActive}
                onRemove={removeCode}
              />
            </div>

            <div className="col">
              <section className="panel" style={{ flex: '1 1 58%' }}>
                <Hero code={active} tick={tick} now={now} />
                <Chart bars={bars} livePrice={livePrice} scheme={scheme} theme={theme} loading={barsLoading} />
              </section>

              <section className="panel" style={{ flex: '1 1 42%' }}>
                <div className="panel-head">
                  <div className="tabs">
                    <button className={`tab${tab === 'calendar' ? ' on' : ''}`} onClick={() => setTab('calendar')}>
                      财经日历
                    </button>
                    <button className={`tab${tab === 'news' ? ' on' : ''}`} onClick={() => setTab('news')}>
                      深度资讯
                    </button>
                  </div>
                  <span className="panel-sub">
                    {tab === 'calendar' ? `本周 ${stream.calendar.length} 项` : `${stream.news.length} 篇`}
                  </span>
                </div>
                {tab === 'calendar' ? (
                  <CalendarPanel events={stream.calendar} now={now} />
                ) : (
                  <NewsPanel live={stream.news} onOpen={setArticleId} />
                )}
              </section>
            </div>

            <div className="col">
              <FlashFeed live={stream.flashes} fresh={stream.freshFlash} now={now} />
            </div>
          </div>
        )}

        {view === 'overview' && (
          <div className="page">
            <Overview meta={meta} quotes={stream.quotes} now={now} onPick={pickFromOverview} />
          </div>
        )}

        {view === 'research' && (
          <div className="page">
            <Research onOpen={setResTarget} />
          </div>
        )}
      </div>

      {pickerOpen && (
        <CodePicker codes={stream.codes} selected={watch} onToggle={toggleCode} onClose={() => setPickerOpen(false)} />
      )}
      {articleId && <ArticleModal id={articleId} onClose={() => setArticleId(null)} />}
      {resTarget && <ResearchModal target={resTarget} onClose={() => setResTarget(null)} />}
    </div>
  );
}
