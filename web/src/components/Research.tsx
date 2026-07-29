import { useCallback, useEffect, useState } from 'react';
import { ApiError, research, type WisburgDetail, type WisburgItem, type WisburgPage } from '../lib/api';
import { bjFull } from '../lib/format';

type Source =
  | { kind: 'feed'; label: string }
  | { kind: 'daily'; label: string }
  | { kind: 'articles'; label: string }
  | { kind: 'images'; label: string }
  | { kind: 'report'; label: string; category: string };

const SOURCES: Source[] = [
  { kind: 'feed', label: '资讯流' },
  { kind: 'daily', label: '市场日报' },
  { kind: 'articles', label: '深度文章' },
  { kind: 'report', label: '投行研报', category: 'ib' },
  { kind: 'report', label: '企业研究', category: 'company' },
  { kind: 'report', label: '资管报告', category: 'am' },
  { kind: 'report', label: '公开文献', category: 'archive' },
  { kind: 'report', label: '电话会纪要', category: 'ec' },
  { kind: 'images', label: '图表' },
];

const HOT = ['美联储', '通胀', '原油', '黄金', '日本央行', '人民币', '美债', 'AI'];

const fetchPage = (s: Source, o: { after?: string; query?: string }, signal?: AbortSignal): Promise<WisburgPage> => {
  const args = { first: 20, ...o };
  switch (s.kind) {
    case 'feed':
      return research.feed(args, signal);
    case 'daily':
      return research.daily(args, signal);
    case 'articles':
      return research.articles(args, signal);
    case 'images':
      return research.images(args, signal);
    case 'report':
      return research.reports(s.category, args, signal);
  }
};

interface Props {
  onOpen: (d: { kind: 'article' | 'report'; id: string; category?: string }) => void;
}

export function Research({ onOpen }: Props) {
  const [idx, setIdx] = useState(0);
  const [kw, setKw] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<WisburgPage | null>(null);
  const [items, setItems] = useState<WisburgItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const source = SOURCES[idx]!;

  useEffect(() => {
    const ac = new AbortController();
    setBusy(true);
    setErr(null);
    setItems([]);
    setPage(null);
    fetchPage(source, query ? { query } : {}, ac.signal)
      .then((p) => {
        setPage(p);
        setItems(p.items ?? []);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setErr(e instanceof ApiError ? e.message : '加载失败');
      })
      .finally(() => !ac.signal.aborted && setBusy(false));
    return () => ac.abort();
  }, [idx, query, source]);

  const more = useCallback(async () => {
    if (!page?.next_cursor) return;
    setBusy(true);
    try {
      const next = await fetchPage(source, { after: page.next_cursor, ...(query ? { query } : {}) });
      setPage(next);
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...(next.items ?? []).filter((i) => !seen.has(i.id))];
      });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setBusy(false);
    }
  }, [page, source, query]);

  const open = (it: WisburgItem) => {
    if (source.kind === 'images') return;
    if (source.kind === 'articles') onOpen({ kind: 'article', id: it.id });
    // feed / daily 的 id 与研报 id 同源，按投行研报分类取详情
    else if (source.kind === 'report') onOpen({ kind: 'report', id: it.id, category: source.category });
    else onOpen({ kind: 'report', id: it.id, category: 'ib' });
  };

  return (
    <div className="res">
      <section className="panel res-head">
        <div className="panel-head" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div className="brand-mark" style={{ background: 'linear-gradient(140deg,#7B61FF,#5A82E6)', color: '#fff' }}>
            智
          </div>
          <div className="brand-text">
            <b>智堡 Wisburg 研究</b>
            <span>WISBURG · MCP</span>
          </div>
          <div className="search" style={{ flex: 1, minWidth: 200 }}>
            <span style={{ color: 'var(--fg-mute)', fontSize: 12 }} aria-hidden="true">
              ⌕
            </span>
            <input
              value={kw}
              aria-label="搜索智堡研究"
              placeholder="搜索研报、文章、纪要…"
              onChange={(e) => setKw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && setQuery(kw.trim())}
            />
            {kw && (
              <button
                type="button"
                className="close"
                style={{ width: 18, height: 18, fontSize: 13 }}
                aria-label="清空研究搜索"
                onClick={() => {
                  setKw('');
                  setQuery('');
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>

        <div className="kw-row">
          {SOURCES.map((s, i) => (
            <button key={s.label} className={`kw${i === idx ? ' on' : ''}`} onClick={() => setIdx(i)}>
              {s.label}
            </button>
          ))}
        </div>

        <div className="kw-row" style={{ borderBottom: 'none' }}>
          <span style={{ fontSize: 10.5, color: 'var(--fg-mute)', fontFamily: 'var(--mono)', alignSelf: 'center' }}>
            热词
          </span>
          {HOT.map((h) => (
            <button
              key={h}
              className={`kw${query === h ? ' on' : ''}`}
              onClick={() => {
                const next = query === h ? '' : h;
                setKw(next);
                setQuery(next);
              }}
            >
              {h}
            </button>
          ))}
        </div>
      </section>

      {err && <div className="err">{err}</div>}

      {source.kind === 'images' ? (
        <div className="img-grid">
          {busy && !items.length && [...Array(6)].map((_, i) => <div key={i} className="skel" style={{ height: 190, borderRadius: 12 }} />)}
          {items.map((it) => (
            <figure className="img-card" key={it.id}>
              {it.image && <img src={it.image} alt={it.title} loading="lazy" />}
              <figcaption>
                <b>{it.title}</b>
                <time>{it.time ? bjFull(it.time) : ''}</time>
                {it.summary && <p>{it.summary}</p>}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <div className="res-list">
          {busy && !items.length && (
            <div style={{ display: 'grid', gap: 12 }}>
              {[...Array(5)].map((_, i) => (
                <div key={i} className="panel" style={{ padding: 14, gap: 8 }}>
                  <div className="skel" style={{ width: '70%', height: 14 }} />
                  <div className="skel" style={{ width: '94%' }} />
                  <div className="skel" style={{ width: '84%' }} />
                </div>
              ))}
            </div>
          )}

          {!busy && !items.length && <div className="empty">{query ? `「${query}」没有结果` : '暂无内容'}</div>}

          {items.map((it) => (
            <article
              className="res-card"
              key={it.id}
              onClick={() => open(it)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                open(it);
              }}
              role="button"
              tabIndex={0}
              aria-label={`打开${source.label}：${it.title}`}
            >
              <div className="res-card-head">
                <span className="res-badge">{source.label}</span>
                <time className="num">{it.time ? bjFull(it.time) : ''}</time>
                <span className="res-id num">#{it.id}</span>
              </div>
              <h3>{it.title}</h3>
              {it.summary && <p>{it.summary}</p>}
            </article>
          ))}
        </div>
      )}

      {page?.has_more && items.length > 0 && (
        <button className="more" onClick={more} disabled={busy}>
          {busy ? '加载中…' : '加载更多'}
        </button>
      )}
    </div>
  );
}

/** 智堡详情弹层。正文是 markdown，这里做轻量渲染（标题/加粗/列表/段落）。 */
export function ResearchModal({
  target,
  onClose,
}: {
  target: { kind: 'article' | 'report'; id: string; category?: string };
  onClose: () => void;
}) {
  const [data, setData] = useState<WisburgDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setData(null);
    setErr(null);
    const p =
      target.kind === 'article'
        ? research.article(target.id, ac.signal)
        : research.report(target.category ?? 'ib', target.id, ac.signal);
    p.then(setData).catch((e) => !ac.signal.aborted && setErr(e instanceof ApiError ? e.message : '加载失败'));
    return () => ac.abort();
  }, [target]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="research-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="panel-title" id="research-modal-title">
            智堡 · {target.kind === 'article' ? '文章' : '研报'}
          </span>
          <div className="spacer" />
          {data?.url && (
            <a className="chip" href={data.url} target="_blank" rel="noreferrer noopener">
              原文 ↗
            </a>
          )}
          <button type="button" className="close" onClick={onClose} aria-label="关闭智堡详情">
            ×
          </button>
        </div>
        <div className="modal-body article">
          {err && <div className="err">{err}</div>}
          {!data && !err && (
            <div style={{ display: 'grid', gap: 11 }}>
              <div className="skel" style={{ width: '74%', height: 20 }} />
              {[...Array(8)].map((_, i) => (
                <div key={i} className="skel" style={{ width: `${97 - (i % 3) * 9}%` }} />
              ))}
            </div>
          )}
          {data && (
            <>
              <h2>{data.title}</h2>
              <div className="meta">
                <span>{data.time ? bjFull(data.time) : ''}</span>
                <span>ID {data.id}</span>
              </div>
              <Markdown text={data.content} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 极简 markdown 渲染：只处理标题、无序列表、有序列表、加粗和段落。 */
function Markdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim());
  return (
    <>
      {blocks.map((b, i) => {
        const t = b.trim();
        const h = /^(#{1,6})\s+(.*)$/.exec(t);
        if (h) {
          const level = Math.min(4, h[1]!.length + 1);
          const Tag = `h${level}` as 'h2' | 'h3' | 'h4';
          return <Tag key={i}>{inline(h[2]!)}</Tag>;
        }
        if (/^\s*[*\-•]\s+/m.test(t) || /^\s*\d+\.\s+/m.test(t)) {
          const lines = t.split(/\n/).filter((l) => l.trim());
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*(?:[*\-•]|\d+\.)\s*/, ''))}</li>
              ))}
            </ul>
          );
        }
        return <p key={i}>{inline(t)}</p>;
      })}
    </>
  );
}

function inline(s: string): React.ReactNode[] {
  const clean = s.replace(/<(https?:\/\/[^>]+)>/g, ' ($1) ');
  return clean.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={i} style={{ color: 'var(--fg)' }}>
        {part.slice(2, -2)}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}
