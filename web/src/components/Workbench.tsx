import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, topics, type CompanyFacet, type TimelineItem, type TopicDef, type TopicFeed } from '../lib/api';
import { ago, bjFull, bjHM, fmtPct, fmtPrice, sign } from '../lib/format';

type Lens = 'all' | 'research' | 'market';

const LENS: Array<{ key: Lens; label: string; kinds: TimelineItem['kind'][] }> = [
  { key: 'all', label: '全部', kinds: [] },
  { key: 'research', label: '研究观点', kinds: ['report', 'company', 'feed', 'article'] },
  { key: 'market', label: '盘面消息', kinds: ['flash', 'news'] },
];

interface Props {
  now: number;
  onOpenWisburg: (t: { kind: 'article' | 'report'; id: string; category?: string }) => void;
  onOpenJin10News: (id: string) => void;
  onPickCode: (code: string) => void;
}

/**
 * 主题工作台。
 *
 * 左侧按「品种 / 主题」和「公司」两个维度分面，右侧是**智堡研究 + 金十盘面**
 * 合并后的同一条时间线 —— 研究观点和实时消息并排看，主题若对应可交易品种，
 * 顶部直接给出实时报价。
 */
export function Workbench({ now, onOpenWisburg, onOpenJin10News, onPickCode }: Props) {
  const [defs, setDefs] = useState<TopicDef[]>([]);
  const [groups, setGroups] = useState<Record<string, string>>({});
  const [dim, setDim] = useState<'topic' | 'company'>('topic');
  const [active, setActive] = useState<string>('gold');
  /** 公司维度用自由关键词走同一条接口 */
  const [company, setCompany] = useState<string | null>(null);
  const [lens, setLens] = useState<Lens>('all');

  const [feed, setFeed] = useState<TopicFeed | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [facets, setFacets] = useState<CompanyFacet[] | null>(null);
  const [facetBusy, setFacetBusy] = useState(false);
  const [kw, setKw] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ac = new AbortController();
    topics
      .list(ac.signal)
      .then((d) => {
        setDefs(d.topics);
        setGroups(d.groups);
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, []);

  // 公司分面只在切到公司维度时才拉，省掉两次智堡调用
  useEffect(() => {
    if (dim !== 'company' || facets) return;
    const ac = new AbortController();
    setFacetBusy(true);
    topics
      .companies(ac.signal)
      .then((d) => setFacets(d.facets))
      .catch(() => setFacets([]))
      .finally(() => !ac.signal.aborted && setFacetBusy(false));
    return () => ac.abort();
  }, [dim, facets]);

  const load = useCallback((key: string, custom?: string) => {
    const ac = new AbortController();
    setBusy(true);
    setErr(null);
    topics
      .feed(key, custom, ac.signal)
      .then(setFeed)
      .catch((e) => {
        if (ac.signal.aborted) return;
        setErr(e instanceof ApiError ? e.message : '加载失败');
        setFeed(null);
      })
      .finally(() => !ac.signal.aborted && setBusy(false));
    return () => ac.abort();
  }, []);

  useEffect(() => {
    const key = company ? 'custom' : active;
    const cleanup = load(key, company ?? undefined);
    bodyRef.current?.scrollTo({ top: 0 });
    return cleanup;
  }, [active, company, load]);

  const grouped = useMemo(() => {
    const m = new Map<string, TopicDef[]>();
    for (const t of defs) {
      const arr = m.get(t.group);
      if (arr) arr.push(t);
      else m.set(t.group, [t]);
    }
    return [...m.entries()];
  }, [defs]);

  const shown = useMemo(() => {
    if (!feed) return [];
    const kinds = LENS.find((l) => l.key === lens)?.kinds ?? [];
    return kinds.length ? feed.items.filter((i) => kinds.includes(i.kind)) : feed.items;
  }, [feed, lens]);

  const filteredFacets = useMemo(() => {
    if (!facets) return [];
    const q = kw.trim().toLowerCase();
    return q ? facets.filter((f) => f.name.toLowerCase().includes(q)) : facets;
  }, [facets, kw]);

  const open = (it: TimelineItem) => {
    if (it.source === 'wisburg') {
      onOpenWisburg({ kind: it.kind === 'article' ? 'article' : 'report', id: it.id, category: it.category ?? 'ib' });
    } else if (it.kind === 'news') {
      onOpenJin10News(it.id);
    } else if (it.url) {
      window.open(it.url, '_blank', 'noopener,noreferrer');
    }
  };

  const q = feed?.quote;
  const s = sign(q?.ups_percent);

  return (
    <div className="wb">
      {/* ── 左侧分面 ─────────────────────────────────────── */}
      <aside className="panel wb-side">
        <div className="panel-head">
          <div className="tabs">
            <button className={`tab${dim === 'topic' ? ' on' : ''}`} onClick={() => setDim('topic')}>
              品种 / 主题
            </button>
            <button className={`tab${dim === 'company' ? ' on' : ''}`} onClick={() => setDim('company')}>
              公司
            </button>
          </div>
        </div>

        <div className="panel-body">
          {dim === 'topic' &&
            grouped.map(([g, list]) => (
              <div className="wb-group" key={g}>
                <div className="wb-group-label">{groups[g] ?? g}</div>
                {list.map((t) => (
                  <button
                    key={t.key}
                    className={`wb-facet${!company && active === t.key ? ' on' : ''}`}
                    onClick={() => {
                      setCompany(null);
                      setActive(t.key);
                    }}
                  >
                    <span>{t.label}</span>
                    {t.code && <em>{t.code}</em>}
                  </button>
                ))}
              </div>
            ))}

          {dim === 'company' && (
            <>
              <div className="wb-group" style={{ paddingBottom: 0 }}>
                <div className="search" style={{ margin: '2px 0 8px' }}>
                  <span style={{ color: 'var(--fg-mute)', fontSize: 12 }} aria-hidden="true">
                    ⌕
                  </span>
                  <input
                    value={kw}
                    aria-label="筛选或搜索公司"
                    placeholder="筛选公司…"
                    onChange={(e) => setKw(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && kw.trim()) setCompany(kw.trim());
                    }}
                  />
                </div>
              </div>

              {facetBusy && (
                <div className="wb-group">
                  {[...Array(10)].map((_, i) => (
                    <div key={i} className="skel" style={{ margin: '7px 0', width: `${88 - i * 4}%` }} />
                  ))}
                </div>
              )}

              {!facetBusy && !filteredFacets.length && (
                <div className="empty">{kw ? '无匹配公司，回车可直接搜索' : '暂无公司数据'}</div>
              )}

              <div className="wb-group">
                {filteredFacets.map((f) => (
                  <button
                    key={f.name}
                    className={`wb-facet${company === f.name ? ' on' : ''}`}
                    onClick={() => setCompany(f.name)}
                    title={f.refs
                      .slice(0, 4)
                      .map((r) => r.title)
                      .join('\n')}
                  >
                    <span>{f.name}</span>
                    <em>{f.count}</em>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="wb-side-foot">
          {dim === 'topic' ? '主题聚合：智堡研究 + 金十盘面' : `从最近 100 份企业研究 / 电话会中抽取`}
        </div>
      </aside>

      {/* ── 右侧时间线 ───────────────────────────────────── */}
      <section className="panel wb-main">
        <div className="panel-head" style={{ flexWrap: 'wrap', gap: 10 }}>
          <span className="panel-title">{company ? `公司 · ${company}` : feed?.label || '…'}</span>
          {feed?.keyword && <span className="wb-kw">关键词「{feed.keyword}」</span>}
          <div className="spacer" />
          <div className="tabs">
            {LENS.map((l) => (
              <button key={l.key} className={`tab${lens === l.key ? ' on' : ''}`} onClick={() => setLens(l.key)}>
                {l.label}
                {feed && l.kinds.length > 0 && (
                  <em className="tab-n">{feed.items.filter((i) => l.kinds.includes(i.kind)).length}</em>
                )}
                {feed && l.key === 'all' && <em className="tab-n">{feed.items.length}</em>}
              </button>
            ))}
          </div>
        </div>

        {/* 主题对应可交易品种时，把实时报价摆在最上面 */}
        {q && feed?.code && (
          <button className="wb-quote" onClick={() => onPickCode(feed.code!)} title="在终端页打开这个品种">
            <div>
              <b>{q.name}</b>
              <span>{feed.code}</span>
            </div>
            <div className={`wb-quote-price ${s}`}>{fmtPrice(q.close)}</div>
            <div className={`wb-quote-chg ${s}`}>
              <span>{fmtPct(q.ups_percent)}</span>
              <em>
                今开 {fmtPrice(q.open)} · 高 {fmtPrice(q.high)} · 低 {fmtPrice(q.low)}
              </em>
            </div>
            <div className="wb-quote-age">{ago(q._at, now)}</div>
          </button>
        )}

        {err && <div className="err">{err}</div>}

        <div className="panel-body" ref={bodyRef}>
          {busy && (
            <div style={{ padding: 16, display: 'grid', gap: 14 }}>
              {[...Array(6)].map((_, i) => (
                <div key={i} style={{ display: 'grid', gap: 6 }}>
                  <div className="skel" style={{ width: '30%', height: 10 }} />
                  <div className="skel" style={{ width: `${92 - i * 5}%`, height: 13 }} />
                </div>
              ))}
            </div>
          )}

          {!busy && !shown.length && <div className="empty">该视角下暂无内容</div>}

          {!busy &&
            shown.map((it) => (
              <article
                key={`${it.source}-${it.kind}-${it.id}`}
                className={`tl-item ${it.source}`}
                onClick={() => open(it)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
                  event.preventDefault();
                  open(it);
                }}
                role="button"
                tabIndex={0}
                aria-label={`打开${it.kindLabel}：${it.title}`}
              >
                <div className="tl-time">
                  <b>{bjHM(it.time)}</b>
                  <em>{ago(new Date(it.time).getTime(), now)}</em>
                </div>
                <div className="tl-body">
                  <div className="tl-meta">
                    <span className={`tl-badge ${it.source}`}>{it.kindLabel}</span>
                    {it.companies?.slice(0, 3).map((c) => (
                      <button
                        type="button"
                        key={c}
                        className="tl-chip"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDim('company');
                          setCompany(c);
                        }}
                      >
                        {c}
                      </button>
                    ))}
                    <time>{bjFull(it.time)}</time>
                  </div>
                  <div className="tl-title">{it.title}</div>
                  {it.summary && <p className="tl-sum">{it.summary}</p>}
                </div>
              </article>
            ))}
        </div>
      </section>
    </div>
  );
}
