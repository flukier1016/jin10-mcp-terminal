import fs from 'node:fs';
import path from 'node:path';
import type { QuotaSnapshot, ToolQuota } from '../types.js';

/**
 * 每工具每日调用额度跟踪。
 *
 * 金十的限流口径是"每用户每工具每天 1500 次，按北京时间自然日重置"，
 * 因此这里的日界线固定用 UTC+8 计算，而不是服务器本地时区。
 */

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function beijingDayKey(now = Date.now()): string {
  return new Date(now + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

export function msUntilBeijingMidnight(now = Date.now()): number {
  const shifted = now + BEIJING_OFFSET_MS;
  return DAY_MS - (shifted % DAY_MS);
}

export class QuotaLedger {
  private day = beijingDayKey();
  private counts = new Map<string, number>();
  /** 被服务端明确拒绝（今日额度耗尽）的工具，直到次日重置前不再尝试。 */
  private blocked = new Set<string>();
  private persistenceError: string | null = null;

  constructor(
    private readonly limit: number,
    private readonly reserveRatio: number,
    private readonly sustainHours: number,
    private readonly stateFile?: string,
  ) {
    this.restore();
  }

  private roll(): void {
    const today = beijingDayKey();
    if (today !== this.day) {
      this.day = today;
      this.counts.clear();
      this.blocked.clear();
      this.persist();
    }
  }

  used(tool: string): number {
    this.roll();
    return this.counts.get(tool) ?? 0;
  }

  remaining(tool: string): number {
    return Math.max(0, this.limit - this.used(tool));
  }

  /** 扣除安全垫后真正可花的次数。 */
  spendable(tool: string): number {
    const reserve = Math.ceil(this.limit * this.reserveRatio);
    return Math.max(0, this.remaining(tool) - reserve);
  }

  canSpend(tool: string): boolean {
    this.roll();
    return !this.blocked.has(tool) && this.spendable(tool) > 0;
  }

  record(tool: string): void {
    this.roll();
    this.counts.set(tool, (this.counts.get(tool) ?? 0) + 1);
    this.persist();
  }

  /** 服务端回了"今日该工具调用次数已达上限"，本地直接封到明天。 */
  markExhausted(tool: string): void {
    this.roll();
    this.blocked.add(tool);
    this.counts.set(tool, this.limit);
    this.persist();
  }

  isBlocked(tool: string): boolean {
    this.roll();
    return this.blocked.has(tool);
  }

  /**
   * 按剩余额度算出建议轮询间隔。
   *
   * 目标是让剩下的额度至少还能撑 `sustainHours` 小时的连续在线使用；
   * 额度越少间隔自动拉长，直到贴到 max。这样不会出现"用半小时就没了"。
   */
  suggestIntervalMs(tool: string, min: number, max: number, weight = 1): number {
    const spendable = this.spendable(tool);
    if (spendable <= 0) return max;
    const ideal = (this.sustainHours * 3600 * 1000 * weight) / spendable;
    return Math.min(max, Math.max(min, Math.round(ideal)));
  }

  snapshot(tools: Array<{ tool: string; intervalMs: number }>): QuotaSnapshot {
    this.roll();
    const list: ToolQuota[] = tools.map(({ tool, intervalMs }) => ({
      tool,
      used: this.used(tool),
      limit: this.limit,
      remaining: this.remaining(tool),
      spendable: this.spendable(tool),
      intervalMs,
    }));
    return { day: this.day, resetInMs: msUntilBeijingMidnight(), tools: list };
  }

  get persistenceStatus(): { enabled: boolean; ok: boolean; error: string | null } {
    return {
      enabled: Boolean(this.stateFile),
      ok: Boolean(this.stateFile) && this.persistenceError === null,
      error: this.persistenceError,
    };
  }

  private restore(): void {
    if (!this.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      if (!fs.existsSync(this.stateFile)) return;
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<LedgerState>;
      if (raw.version !== 1 || raw.day !== this.day) return;
      for (const [tool, count] of Object.entries(raw.counts ?? {})) {
        if (Number.isFinite(count) && Number(count) >= 0) this.counts.set(tool, Math.trunc(Number(count)));
      }
      for (const tool of raw.blocked ?? []) {
        if (typeof tool === 'string' && tool) this.blocked.add(tool);
      }
      this.persistenceError = null;
    } catch {
      this.persistenceError = '额度状态读取失败，将在下次写入时重建';
    }
  }

  private persist(): void {
    if (!this.stateFile) return;
    const temp = `${this.stateFile}.${process.pid}.tmp`;
    const state: LedgerState = {
      version: 1,
      day: this.day,
      counts: Object.fromEntries(this.counts),
      blocked: [...this.blocked],
    };
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(temp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, this.stateFile);
      this.persistenceError = null;
    } catch {
      this.persistenceError = '额度状态写入失败，重启后计数可能丢失';
      try {
        fs.unlinkSync(temp);
      } catch {
        // 临时文件可能尚未创建
      }
    }
  }
}

interface LedgerState {
  version: 1;
  day: string;
  counts: Record<string, number>;
  blocked: string[];
}
