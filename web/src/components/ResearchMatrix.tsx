import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  ApiError,
  matrix,
  type MatrixDocument,
  type MatrixFacet,
  type MatrixGrid,
  type MatrixStats,
} from '../lib/api';
import { bjFull } from '../lib/format';

const CATEGORY_LABEL: Record<string, string> = {
  ib: '投行研报',
  company: '企业研究',
  am: '资管报告',
  archive: '公开文献',
  ec: '电话会纪要',
  article: '深度文章',
  feed: '资讯流',
  daily: '市场日报',
  image: '数据图表',
};

const STANCE_ORDER = ['偏多', '偏空', '分歧', '中性'];

export function ResearchMatrix() {
  const [stats, setStats] = useState<MatrixStats | null>(null);
  const [facets, setFacets] = useState<MatrixFacet[]>([]);
  const [grid, setGrid] = useState<MatrixGrid | null>(null);
  const [items, setItems] = useState<MatrixDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [kw, setKw] = useState('');
  const [query, setQuery] = useState('');
  const [topic, setTopic] = useState('');
  const [stance, setStance] = useState('');
  const [category, setCategory] = useState('');
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    Promise.all([matrix.stats(ac.signal), matrix.facets('topic', ac.signal), matrix.grid('topic', 'stance', ac.signal)])
      .then(([nextStats, nextFacets, nextGrid]) => {
        setStats(nextStats);
        setFacets(nextFacets);
        setGrid(nextGrid);
      })
      .catch((error) => {
        if (!ac.signal.aborted) setErr(error instanceof ApiError ? error.message : '矩阵概览加载失败');
      });
    return () => ac.abort();
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    setBusy(true);
    setErr(null);
    matrix
      .search(
        {
          ...(query ? { q: query } : {}),
          ...(topic ? { topic } : {}),
          ...(stance ? { stance } : {}),
          ...(category ? { category } : {}),
          limit: 30,
        },
        ac.signal,
      )
      .then((result) => {
        setItems(result.items);
        setTotal(result.total);
      })
      .catch((error) => {
        if (!ac.signal.aborted) setErr(error instanceof ApiError ? error.message : '矩阵检索失败');
      })
      .finally(() => !ac.signal.aborted && setBusy(false));
    return () => ac.abort();
  }, [query, topic, stance, category]);

  const topics = useMemo(
    () => facets.filter((facet) => facet.dimension === 'topic').slice(0, 14),
    [facets],
  );
  const categories = stats?.byCategory ?? [];
  const rows = useMemo(() => [...new Set(grid?.cells.map((cell) => cell.row) ?? [])], [grid]);
  const columns = useMemo(() => {
    const found = new Set(grid?.cells.map((cell) => cell.column) ?? []);
    return STANCE_ORDER.filter((value) => found.has(value));
  }, [grid]);
  const maxCell = Math.max(1, ...(grid?.cells.map((cell) => cell.count) ?? [1]));

  const loadMore = async () => {
    setBusy(true);
    try {
      const result = await matrix.search({
        ...(query ? { q: query } : {}),
        ...(topic ? { topic } : {}),
        ...(stance ? { stance } : {}),
        ...(category ? { category } : {}),
        limit: 30,
        offset: items.length,
      });
      setItems((current) => [...current, ...result.items.filter((item) => !current.some((x) => x.docKey === item.docKey))]);
      setTotal(result.total);
    } catch (error) {
      setErr(error instanceof ApiError ? error.message : '加载更多失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="matrix-page">
      <section className="panel matrix-hero">
        <div>
          <span className="matrix-kicker">ARCHIVED RESEARCH · LOCAL SQLITE</span>
          <h1>历史研究结论矩阵</h1>
          <p>实时连接已关闭；这里仅查询既有缓存快照。内容按报告、主题、公司、观点方向和期限结构化，结论来自原文段落抽取。</p>
        </div>
        <div className="matrix-metrics">
          <Metric label="文档" value={number(stats?.documents)} />
          <Metric label="完整详情" value={number(stats?.complete)} />
          <Metric label="正文字符" value={compact(stats?.characters)} />
          <Metric label="数据库" value={bytes(stats?.databaseBytes)} />
        </div>
      </section>

      {err && <div className="err">{err}</div>}

      <div className="matrix-layout">
        <section className="panel matrix-grid-panel">
          <div className="panel-head">
            <span className="panel-title">主题 × 观点</span>
            <span className="panel-sub">点击格子筛选</span>
          </div>
          {rows.length ? (
            <div className="matrix-grid-wrap">
              <div className="matrix-grid" style={{ gridTemplateColumns: `minmax(88px,1.2fr) repeat(${columns.length},1fr)` }}>
                <span />
                {columns.map((column) => (
                  <b key={column}>{column}</b>
                ))}
                {rows.slice(0, 12).flatMap((row) => [
                  <strong key={`${row}:label`}>{row}</strong>,
                  ...columns.map((column) => {
                    const count = grid?.cells.find((cell) => cell.row === row && cell.column === column)?.count ?? 0;
                    const intensity = count / maxCell;
                    return (
                      <button
                        type="button"
                        key={`${row}:${column}`}
                        className={`matrix-cell${topic === row && stance === column ? ' on' : ''}`}
                        style={{ '--matrix-alpha': `${8 + intensity * 72}%` } as CSSProperties}
                        onClick={() => {
                          const same = topic === row && stance === column;
                          setTopic(same ? '' : row);
                          setStance(same ? '' : column);
                        }}
                        aria-label={`${row}，${column}，${count} 篇`}
                      >
                        {count || '·'}
                      </button>
                    );
                  }),
                ])}
              </div>
            </div>
          ) : (
            <div className="empty">等待同步数据后生成矩阵</div>
          )}
        </section>

        <section className="panel matrix-sync">
          <div className="panel-head">
            <span className="panel-title">缓存状态</span>
            <span className={`sync-dot${stats?.lastRun?.status === 'running' ? ' active' : ''}`} />
          </div>
          <div className="matrix-range">
            <span>最新</span>
            <b>{stats?.newest ? bjFull(stats.newest) : '—'}</b>
            <span>最早</span>
            <b>{stats?.oldest ? bjFull(stats.oldest) : '—'}</b>
          </div>
          <div className="matrix-sources">
            {(stats?.sync ?? []).slice(0, 9).map((source) => (
              <div key={source.source}>
                <span>{source.source.replace('report:', '')}</span>
                <b>{number(source.items)}</b>
                <em>{source.completed ? '完成' : source.cursor ? `游标 ${source.cursor}` : '待同步'}</em>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel matrix-filter">
        <form
          className="search matrix-search"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(kw.trim());
          }}
        >
          <span aria-hidden="true">⌕</span>
          <input
            value={kw}
            aria-label="搜索研究矩阵"
            placeholder="搜索公司、资产、宏观主题或原文结论…"
            onChange={(event) => setKw(event.target.value)}
          />
          {kw && (
            <button
              type="button"
              className="close"
              aria-label="清空矩阵搜索"
              onClick={() => {
                setKw('');
                setQuery('');
              }}
            >
              ×
            </button>
          )}
          <button type="submit" className="matrix-submit">
            搜索
          </button>
        </form>
        <div className="matrix-chips" aria-label="矩阵筛选">
          <button type="button" className={!category ? 'on' : ''} onClick={() => setCategory('')}>
            全部 {number(stats?.documents)}
          </button>
          {categories.slice(0, 8).map((item) => (
            <button
              type="button"
              key={item.key}
              className={category === item.key ? 'on' : ''}
              onClick={() => setCategory(category === item.key ? '' : item.key)}
            >
              {CATEGORY_LABEL[item.key] ?? item.key} {number(item.count)}
            </button>
          ))}
        </div>
        <div className="matrix-chips compact">
          {topics.map((item) => (
            <button
              type="button"
              key={item.value}
              className={topic === item.value ? 'on' : ''}
              onClick={() => setTopic(topic === item.value ? '' : item.value)}
            >
              {item.value} {number(item.count)}
            </button>
          ))}
        </div>
      </section>

      <div className="matrix-result-head">
        <b>{number(total)} 篇命中</b>
        {(query || topic || stance || category) && (
          <button
            type="button"
            onClick={() => {
              setKw('');
              setQuery('');
              setTopic('');
              setStance('');
              setCategory('');
            }}
          >
            清除筛选
          </button>
        )}
      </div>

      <div className="matrix-results" aria-busy={busy}>
        {busy && !items.length && [...Array(6)].map((_, index) => <div key={index} className="skel matrix-skeleton" />)}
        {!busy && !items.length && (
          <div className="empty">
            {stats?.documents ? '没有符合当前条件的研究' : '缓存数据库尚未挂载，请检查 MATRIX_DB_PATH / STATE_DIR'}
          </div>
        )}
        {items.map((item) => (
          <article className="matrix-card panel" key={item.docKey}>
            <button
              type="button"
              className="matrix-card-open"
              aria-haspopup="dialog"
              aria-label={`查看缓存详情：${item.title}`}
              onClick={() => setDetailKey(item.docKey)}
            >
              <div className="matrix-card-meta">
                <span>{CATEGORY_LABEL[item.category] ?? item.category}</span>
                <time>{item.publishedAt ? bjFull(item.publishedAt) : '时间未知'}</time>
                <em>{item.detailStatus === 'complete' ? `${compact(item.charCount)} 字` : '元数据'}</em>
              </div>
              <h2>{item.title}</h2>
              <p>{item.conclusion || item.summary || '等待详情同步与结论抽取。'}</p>
              <span className="matrix-card-action">
                {item.detailStatus === 'complete' ? '查看缓存详情' : '查看元数据'} <span aria-hidden="true">→</span>
              </span>
            </button>
            <div className="matrix-tags">
              {item.tags
                .filter((tag) => ['topic', 'company', 'stance', 'horizon', 'region'].includes(tag.dimension))
                .slice(0, 10)
                .map((tag) => (
                  <button
                    type="button"
                    key={`${tag.dimension}:${tag.value}`}
                    onClick={() => {
                      if (tag.dimension === 'topic') setTopic(tag.value);
                      else if (tag.dimension === 'stance') setStance(tag.value);
                      else setQuery(tag.value);
                    }}
                  >
                    {tag.value}
                  </button>
                ))}
            </div>
          </article>
        ))}
      </div>

      {items.length < total && (
        <button type="button" className="more" onClick={loadMore} disabled={busy}>
          {busy ? '加载中…' : `加载更多（${number(items.length)}/${number(total)}）`}
        </button>
      )}

      {detailKey && <MatrixDetailModal docKey={detailKey} onClose={() => setDetailKey(null)} />}
    </div>
  );
}

function MatrixDetailModal({ docKey, onClose }: { docKey: string; onClose: () => void }) {
  const [data, setData] = useState<MatrixDocument | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    matrix
      .document(docKey, ac.signal)
      .then(setData)
      .catch((nextError) => {
        if (!ac.signal.aborted) setError(nextError instanceof ApiError ? nextError.message : '缓存详情加载失败');
      });
    return () => ac.abort();
  }, [docKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="modal matrix-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="matrix-detail-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="panel-title" id="matrix-detail-title">
            缓存研究详情
          </span>
          <div className="spacer" />
          {data && (
            <span className={`matrix-detail-state${data.detailStatus === 'complete' ? ' complete' : ''}`}>
              {data.detailStatus === 'complete' ? '详情已缓存' : '仅有元数据'}
            </span>
          )}
          <button type="button" className="close" onClick={onClose} aria-label="关闭缓存研究详情">
            ×
          </button>
        </div>

        <div className="modal-body matrix-detail-body">
          {error && <div className="err">{error}</div>}
          {!data && !error && (
            <div className="matrix-detail-loading">
              <div className="skel" style={{ width: '76%', height: 22 }} />
              <div className="skel" style={{ width: '42%' }} />
              {[...Array(5)].map((_, index) => (
                <div key={index} className="skel" style={{ width: `${98 - (index % 3) * 9}%` }} />
              ))}
            </div>
          )}

          {data && (
            <>
              <h2>{data.title}</h2>
              <div className="meta matrix-detail-meta">
                <span>{CATEGORY_LABEL[data.category] ?? data.category}</span>
                <span>{data.publishedAt ? bjFull(data.publishedAt) : '时间未知'}</span>
                <span>ID {data.externalId}</span>
              </div>

              {data.conclusion && (
                <section className="matrix-detail-section">
                  <h3>原文结论抽取</h3>
                  <p>{data.conclusion}</p>
                </section>
              )}
              {data.summary && data.summary !== data.conclusion && (
                <section className="matrix-detail-section">
                  <h3>缓存摘要</h3>
                  <p>{data.summary}</p>
                </section>
              )}

              <div className="matrix-detail-note">
                {data.detailStatus === 'complete'
                  ? `已缓存 ${number(data.charCount)} 个正文字符；公网部署只展示结构化结论和摘要，完整正文仍受访问保护。`
                  : '当前快照只有元数据，智堡实时权限已关闭，因此无法继续回源补齐正文。'}
              </div>

              <div className="matrix-detail-tags" aria-label="研究标签">
                {data.tags.map((tag) => (
                  <span key={`${tag.dimension}:${tag.value}`}>{tag.value}</span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <b className="num">{value}</b>
    </div>
  );
}

function number(value: number | null | undefined): string {
  return Math.max(0, Number(value ?? 0)).toLocaleString('zh-CN');
}

function compact(value: number | null | undefined): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value ?? 0));
}

function bytes(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}
