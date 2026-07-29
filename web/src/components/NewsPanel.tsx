import { useEffect, useMemo, useState } from 'react';
import type { NewsItem } from '../types';
import { api, ApiError } from '../lib/api';
import { bjFull } from '../lib/format';

interface Props {
  live: NewsItem[];
  onOpen: (id: string) => void;
}

export function NewsPanel({ live, onOpen }: Props) {
  const [kw, setKw] = useState('');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<NewsItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [older, setOlder] = useState<NewsItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!query) {
      setFound(null);
      setCursor(null);
      setErr(null);
      return;
    }
    const ac = new AbortController();
    setBusy(true);
    setErr(null);
    api
      .searchNews(query, undefined, ac.signal)
      .then((p) => {
        setFound(p.items ?? []);
        setCursor(p.next_cursor != null ? String(p.next_cursor) : null);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setErr(e instanceof ApiError ? e.message : '搜索失败');
        setFound([]);
      })
      .finally(() => !ac.signal.aborted && setBusy(false));
    return () => ac.abort();
  }, [query]);

  const loadMore = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (query) {
        const page = await api.searchNews(query, cursor ?? undefined);
        setFound((prev) => [...(prev ?? []), ...(page.items ?? [])]);
        setCursor(page.next_cursor != null ? String(page.next_cursor) : null);
      } else {
        const tail = older.at(-1) ?? live.at(-1);
        const c = cursor ?? (tail ? String(new Date(tail.time).getTime()) : undefined);
        const page = await api.news(c);
        const seen = new Set([...live, ...older].map((n) => n.id));
        setOlder((prev) => [...prev, ...(page.items ?? []).filter((n) => !seen.has(n.id))]);
        setCursor(page.next_cursor != null ? String(page.next_cursor) : null);
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setBusy(false);
    }
  };

  const items = useMemo(() => (found ? found : [...live, ...older]), [found, live, older]);

  return (
    <>
      <div className="kw-row" style={{ paddingTop: 9, paddingBottom: 9 }}>
        <div className="search" style={{ flex: 1 }}>
          <span style={{ color: 'var(--fg-mute)', fontSize: 12 }} aria-hidden="true">
            ⌕
          </span>
          <input
            value={kw}
            aria-label="搜索深度资讯"
            placeholder="搜索文章…"
            onChange={(e) => setKw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              setOlder([]);
              setCursor(null);
              setQuery(kw.trim());
            }}
          />
          {kw && (
            <button
              type="button"
              className="close"
              style={{ width: 18, height: 18, fontSize: 13 }}
              aria-label="清空资讯搜索"
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

      {err && <div className="err">{err}</div>}

      <div className="panel-body">
        {busy && !items.length && (
          <div style={{ padding: 14, display: 'grid', gap: 10 }}>
            {[...Array(4)].map((_, i) => (
              <div key={i} style={{ display: 'grid', gap: 6 }}>
                <div className="skel" style={{ width: '82%', height: 13 }} />
                <div className="skel" style={{ width: '96%' }} />
              </div>
            ))}
          </div>
        )}

        {!busy && !items.length && <div className="empty">{query ? '没有匹配的文章' : '等待资讯…'}</div>}

        {items.map((n) => (
          <article
            key={n.id}
            className="news-item"
            onClick={() => onOpen(n.id)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onOpen(n.id);
            }}
            role="button"
            tabIndex={0}
            aria-label={`打开资讯：${n.title}`}
          >
            <div className="news-title">{n.title}</div>
            {n.introduction && <div className="news-intro">{n.introduction}</div>}
            <div className="news-meta">{bjFull(n.time)}</div>
          </article>
        ))}

        {items.length > 0 && (!query || cursor) && (
          <button className="more" onClick={loadMore} disabled={busy}>
            {busy ? '加载中…' : '加载更多'}
          </button>
        )}
      </div>
    </>
  );
}
