import { useEffect, useRef, useState } from 'react';

interface Props {
  /** 智堡不可用时隐藏"含研究"选项。 */
  wisburgOn: boolean;
}

const OPTIONS = [
  {
    key: 'html',
    icon: '🖨',
    label: 'HTML 报告',
    hint: '新标签打开，可直接打印成 PDF',
  },
  {
    key: 'md',
    icon: '📄',
    label: 'Markdown',
    hint: '下载 .md，可粘进微信 / 邮件 / 笔记',
  },
  {
    key: 'json',
    icon: '{ }',
    label: 'JSON',
    hint: '下载结构化数据，便于二次处理',
  },
] as const;

/**
 * 一键导出市场日报。
 *
 * 报告在服务端用内存快照生成 —— 不消耗金十额度，可以随便点；
 * 只有勾上"含智堡研究"才会多打 2 次智堡调用。
 */
export function ExportMenu({ wisburgOn }: Props) {
  const [open, setOpen] = useState(false);
  const [research, setResearch] = useState(wisburgOn);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const go = (format: string) => {
    const q = new URLSearchParams({ format });
    if (research && wisburgOn) q.set('research', '1');
    // HTML 走新标签（里面自带打印按钮），其余走下载
    if (format === 'html') {
      window.open(`/api/report?${q}`, '_blank', 'noopener');
    } else {
      q.set('download', '1');
      const a = document.createElement('a');
      a.href = `/api/report?${q}`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    setOpen(false);
  };

  return (
    <div className="export" ref={boxRef}>
      <button className={`chip${open ? ' on' : ''}`} onClick={() => setOpen((v) => !v)} title="导出市场日报">
        ⤓ 导出报告
      </button>

      {open && (
        <div className="export-menu" role="menu">
          <div className="export-head">市场日报</div>
          {OPTIONS.map((o) => (
            <button key={o.key} className="export-item" role="menuitem" onClick={() => go(o.key)}>
              <i>{o.icon}</i>
              <span>
                <b>{o.label}</b>
                <em>{o.hint}</em>
              </span>
            </button>
          ))}

          {wisburgOn && (
            <label className="export-opt">
              <input type="checkbox" checked={research} onChange={(e) => setResearch(e.target.checked)} />
              <span>
                含智堡研究
                <em>额外 2 次智堡调用</em>
              </span>
            </label>
          )}

          <div className="export-foot">行情 / 日历 / 快讯来自服务端快照，导出不消耗金十额度</div>
        </div>
      )}
    </div>
  );
}
