/** 报价小数位随价格量级自适应 —— 日元 157.2 和黄金 4122.39 不该用同一套精度。 */
export function priceDigits(v: number): number {
  const a = Math.abs(v);
  if (a >= 1000) return 2;
  if (a >= 100) return 3;
  if (a >= 10) return 4;
  if (a >= 1) return 4;
  return 5;
}

export function fmtPrice(v: string | number | null | undefined): string {
  const n = typeof v === 'string' ? Number(v) : v;
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: priceDigits(n),
    maximumFractionDigits: priceDigits(n),
  });
}

export function fmtPct(v: string | number | null | undefined): string {
  const n = typeof v === 'string' ? Number(v) : v;
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export function fmtDelta(v: string | number | null | undefined): string {
  const n = typeof v === 'string' ? Number(v) : v;
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${fmtPrice(n)}`;
}

export function fmtVolume(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(2)}万`;
  return String(v);
}

export const sign = (v: string | number | null | undefined): 'up' | 'down' | 'flat' => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n as number) || n === 0) return 'flat';
  return (n as number) > 0 ? 'up' : 'down';
};

/** 全站统一用北京时间显示，与金十的数据口径一致。 */
const BJ: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Shanghai', hour12: false };

export function bjTime(iso: string | number | Date): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { ...BJ, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function bjHM(iso: string | number | Date): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { ...BJ, hour: '2-digit', minute: '2-digit' });
}

export function bjDate(iso: string | number | Date): string {
  return new Date(iso).toLocaleDateString('zh-CN', { ...BJ, month: '2-digit', day: '2-digit' });
}

export function bjFull(iso: string | number | Date): string {
  return `${bjDate(iso)} ${bjTime(iso)}`;
}

export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  return `${Math.floor(s / 86400)}天前`;
}

export function fmtInterval(ms: number): string {
  if (!ms) return '按需';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.round(ms / 60_000)}min`;
}

export function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}m`;
}

/** 财经日历里 "-0.4" 这类值直接展示，null/空串统一成占位符。 */
export const dash = (v: string | null | undefined): string => (v === null || v === undefined || v === '' ? '—' : v);
