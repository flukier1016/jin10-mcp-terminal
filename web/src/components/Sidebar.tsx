export type View = 'terminal' | 'overview' | 'research';

interface Props {
  view: View;
  onView: (v: View) => void;
  wisburgOn: boolean;
}

const ITEMS: Array<{ key: View; label: string; icon: string; hint: string }> = [
  { key: 'terminal', label: '终端', icon: '◧', hint: '实时行情 · K线 · 7×24快讯' },
  { key: 'overview', label: '总览', icon: '▦', hint: '按地区/品种汇总热力图' },
  { key: 'research', label: '研究', icon: '◈', hint: '智堡研报 · 深度文章' },
];

export function Sidebar({ view, onView, wisburgOn }: Props) {
  return (
    <nav className="rail">
      {ITEMS.map((it) => {
        const disabled = it.key === 'research' && !wisburgOn;
        return (
          <button
            key={it.key}
            className={`rail-btn${view === it.key ? ' on' : ''}`}
            onClick={() => !disabled && onView(it.key)}
            disabled={disabled}
            title={disabled ? '未配置 WISBURG_TOKEN' : it.hint}
          >
            <i>{it.icon}</i>
            <span>{it.label}</span>
          </button>
        );
      })}
      <div className="rail-foot">
        <span title="数据源">MCP</span>
        <em className={wisburgOn ? 'dual' : ''}>{wisburgOn ? '×2' : '×1'}</em>
      </div>
    </nav>
  );
}
