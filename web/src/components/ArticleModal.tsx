import { useEffect, useState } from 'react';
import type { NewsDetail } from '../types';
import { api, ApiError } from '../lib/api';
import { bjFull } from '../lib/format';

interface Props {
  id: string;
  onClose: () => void;
}

/** 正文里夹着 <url> 形式的裸链接，剥掉尖括号后按段落渲染。 */
function paragraphs(content: string): string[] {
  return content
    .replace(/<(https?:\/\/[^>]+)>/g, ' ($1) ')
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function ArticleModal({ id, onClose }: Props) {
  const [data, setData] = useState<NewsDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setData(null);
    setErr(null);
    api
      .newsDetail(id, ac.signal)
      .then(setData)
      .catch((e) => !ac.signal.aborted && setErr(e instanceof ApiError ? e.message : '加载失败'));
    return () => ac.abort();
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="panel-title">资讯详情</span>
          <div className="spacer" />
          {data?.url && (
            <a className="chip" href={data.url} target="_blank" rel="noreferrer noopener">
              金十原文 ↗
            </a>
          )}
          <button className="close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body article">
          {err && <div className="err">{err}</div>}

          {!data && !err && (
            <div style={{ display: 'grid', gap: 11 }}>
              <div className="skel" style={{ width: '72%', height: 20 }} />
              <div className="skel" style={{ width: '40%' }} />
              {[...Array(7)].map((_, i) => (
                <div key={i} className="skel" style={{ width: `${98 - (i % 3) * 8}%` }} />
              ))}
            </div>
          )}

          {data && (
            <>
              <h2>{data.title}</h2>
              <div className="meta">
                <span>{bjFull(data.time)}</span>
                <span>ID {data.id}</span>
              </div>
              {data.introduction && <div className="intro">{data.introduction}</div>}
              {paragraphs(data.content ?? '').map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
