import { useEffect, useMemo, useState } from 'react';
import type { QuoteCode } from '../types';

interface Props {
  codes: QuoteCode[];
  selected: string[];
  onToggle: (code: string) => void;
  onClose: () => void;
}

/** 按名称前缀粗分组，几百个品种平铺是找不到东西的。 */
const GROUPS: Array<{ label: string; test: (c: QuoteCode) => boolean }> = [
  { label: '贵金属 / 能源', test: (c) => /^(XAU|XAG|XPT|XPD|US?OIL|UKOIL|NGAS|COPPER|PAXG)/.test(c.code) },
  { label: '外汇', test: (c) => /^(EUR|GBP|AUD|NZD|USD)[A-Z]{3}$/.test(c.code) },
  { label: '股指', test: (c) => /指数|富时|恒生|日经|道琼斯|标普|证/.test(c.name) },
  { label: '银行账户产品', test: (c) => /^(I|A|CMB|CZB|ICBC|ZH)/.test(c.code) && /行|积存/.test(c.name) },
];

export function CodePicker({ codes, selected, onToggle, onClose }: Props) {
  const [kw, setKw] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const groups = useMemo(() => {
    const q = kw.trim().toUpperCase();
    const hit = q ? codes.filter((c) => c.code.includes(q) || c.name.includes(kw.trim())) : codes;

    if (q) return [{ label: `搜索结果 (${hit.length})`, items: hit.slice(0, 200) }];

    const rest = [...hit];
    const out: Array<{ label: string; items: QuoteCode[] }> = [];
    for (const g of GROUPS) {
      const items: QuoteCode[] = [];
      for (let i = rest.length - 1; i >= 0; i--) {
        if (g.test(rest[i]!)) items.unshift(...rest.splice(i, 1));
      }
      if (items.length) out.push({ label: `${g.label} (${items.length})`, items });
    }
    if (rest.length) out.push({ label: `其他 (${rest.length})`, items: rest });
    return out;
  }, [codes, kw]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="panel-title">添加品种</span>
          <div className="search" style={{ flex: 1 }}>
            <span style={{ color: 'var(--fg-mute)', fontSize: 12 }}>⌕</span>
            <input autoFocus value={kw} placeholder="搜索代码或名称，如 XAU / 黄金" onChange={(e) => setKw(e.target.value)} />
          </div>
          <span className="panel-sub" style={{ margin: 0 }}>
            已选 {selected.length}
          </span>
          <button className="close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          {!codes.length && <div className="empty">品种列表加载中…（来自 MCP 资源 quote://codes）</div>}
          {groups.map((g) => (
            <div key={g.label} style={{ marginBottom: 18 }}>
              <div
                style={{
                  fontSize: 10.5,
                  letterSpacing: '0.09em',
                  color: 'var(--fg-mute)',
                  fontFamily: 'var(--mono)',
                  marginBottom: 8,
                }}
              >
                {g.label}
              </div>
              <div className="code-grid">
                {g.items.map((c) => (
                  <button
                    key={c.code}
                    className={`code-cell${selected.includes(c.code) ? ' on' : ''}`}
                    onClick={() => onToggle(c.code)}
                    title={`${c.code} · ${c.name}`}
                  >
                    <b>{c.code}</b>
                    <span>{c.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
