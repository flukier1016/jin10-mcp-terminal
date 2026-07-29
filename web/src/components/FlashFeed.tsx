import { useEffect, useMemo, useRef, useState } from 'react';
import type { FlashItem } from '../types';
import { api, ApiError } from '../lib/api';
import { ago, bjHM } from '../lib/format';

const HOT = ['黄金', '原油', '美联储', '日元', '通胀', '非农', '日本央行', '欧佩克'];

interface Props {
  live: FlashItem[];
  fresh: Set<string>;
  now: number;
}

const keyOf = (i: FlashItem) => i.id ?? i.url ?? `${i.time}|${i.content.slice(0, 40)}`;

/** 高亮命中的关键词，让搜索结果一眼能看出为什么被匹配。 */
function highlight(text: string, kw: string) {
  if (!kw) return text;
  const parts = text.split(kw);
  if (parts.length === 1) return text;
  return parts.flatMap((p, i) => (i === 0 ? [p] : [<mark key={i}>{kw}</mark>, p]));
}

export function FlashFeed({ live, fresh, now }: Props) {
  const [kw, setKw] = useState('');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<FlashItem[] | null>(null);
  const [older, setOlder] = useState<FlashItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 搜索：search_flash 一次最多 150 条且不支持翻页
  useEffect(() => {
    if (!query) {
      setFound(null);
      setErr(null);
      return;
    }
    const ac = new AbortController();
    setBusy(true);
    setErr(null);
    api
      .searchFlash(query, ac.signal)
      .then((p) => setFound(p.items ?? []))
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
      const tail = older.at(-1) ?? live.at(-1);
      // 首次翻页没有服务端 cursor，用最后一条的时间戳（毫秒）当游标
      const c = cursor ?? (tail ? String(new Date(tail.time).getTime()) : undefined);
      const page = await api.flash(c);
      const seen = new Set([...live, ...older].map(keyOf));
      setOlder((prev) => [...prev, ...(page.items ?? []).filter((i) => !seen.has(keyOf(i)))]);
      setCursor(page.next_cursor !== null && page.next_cursor !== undefined ? String(page.next_cursor) : null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setBusy(false);
    }
  };

  const items = useMemo(() => (found ? found : [...live, ...older]), [found, live, older]);

  const submit = (v: string) => {
    setKw(v);
    setQuery(v.trim());
    bodyRef.current?.scrollTo({ top: 0 });
  };

  return (
    <section className="panel" style={{ flex: 1 }}>
      <div className="panel-head">
        <span className="panel-title">7×24 快讯</span>
        <div className="search" style={{ flex: 1, marginLeft: 8 }}>
          <span style={{ color: 'var(--fg-mute)', fontSize: 12 }} aria-hidden="true">
            ⌕
          </span>
          <input
            value={kw}
            aria-label="搜索快讯"
            placeholder="搜索快讯…"
            onChange={(e) => setKw(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit(kw)}
          />
          {kw && (
            <button
              type="button"
              className="close"
              style={{ width: 18, height: 18, fontSize: 13 }}
              onClick={() => submit('')}
              aria-label="清空快讯搜索"
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div className="kw-row">
        {HOT.map((h) => (
          <button key={h} className={`kw${query === h ? ' on' : ''}`} onClick={() => submit(query === h ? '' : h)}>
            {h}
          </button>
        ))}
      </div>

      {err && <div className="err">{err}</div>}

      <div className="panel-body" ref={bodyRef}>
        {found && (
          <div style={{ padding: '7px 13px', fontSize: 11, color: 'var(--fg-mute)', fontFamily: 'var(--mono)' }}>
            「{query}」命中 {found.length} 条{found.length >= 150 ? '（上限 150）' : ''}
          </div>
        )}

        {busy && !items.length && (
          <div style={{ padding: 13, display: 'grid', gap: 9 }}>
            {[...Array(6)].map((_, i) => (
              <div key={i} className="skel" style={{ width: `${92 - i * 6}%` }} />
            ))}
          </div>
        )}

        {!busy && !items.length && <div className="empty">{query ? '没有匹配的快讯' : '等待快讯推送…'}</div>}

        {items.map((it) => {
          const k = keyOf(it);
          return (
            <article key={k} className={`flash-item${!found && fresh.has(k) ? ' fresh' : ''}`}>
              <div className="flash-time">
                {bjHM(it.time)}
                <div style={{ fontSize: 9, opacity: 0.65 }}>{ago(new Date(it.time).getTime(), now)}</div>
              </div>
              <div>
                <div className="flash-text">{highlight(it.content, found ? query : '')}</div>
                {it.url && (
                  <a className="flash-link" href={it.url} target="_blank" rel="noreferrer noopener">
                    原文 ↗
                  </a>
                )}
              </div>
            </article>
          );
        })}

        {!found && items.length > 0 && (
          <button className="more" onClick={loadMore} disabled={busy}>
            {busy ? '加载中…' : '加载更早快讯'}
          </button>
        )}
      </div>
    </section>
  );
}
