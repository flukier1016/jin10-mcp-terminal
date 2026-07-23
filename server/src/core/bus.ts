import type { Response } from 'express';
import type { StreamEvent } from '../types.js';

interface Subscriber {
  id: number;
  res: Response;
  codes: Set<string>;
  /** 当前前台聚焦的品种，享受更高轮询权重。 */
  focus: string | null;
  since: number;
}

/**
 * SSE 扇出中心。
 *
 * 所有浏览器共享服务端的同一份轮询数据 —— 100 个页面和 1 个页面消耗完全相同的
 * 金十额度，这是本项目能在 1500 次/天限制下做到"实时"的前提。
 */
export class StreamBus {
  private subs = new Map<number, Subscriber>();
  private seq = 0;
  private listeners = new Set<() => void>();

  get size(): number {
    return this.subs.size;
  }

  /** 所有在线客户端订阅的品种并集。 */
  subscribedCodes(): string[] {
    const set = new Set<string>();
    for (const s of this.subs.values()) for (const c of s.codes) set.add(c);
    return [...set];
  }

  /** 被至少一个客户端聚焦的品种（轮询权重更高）。 */
  focusedCodes(): Set<string> {
    const set = new Set<string>();
    for (const s of this.subs.values()) if (s.focus) set.add(s.focus);
    return set;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  add(res: Response, codes: string[], focus: string | null): number {
    const id = ++this.seq;
    this.subs.set(id, { id, res, codes: new Set(codes), focus, since: Date.now() });
    this.notify();
    return id;
  }

  update(id: number, codes: string[], focus: string | null): void {
    const sub = this.subs.get(id);
    if (!sub) return;
    sub.codes = new Set(codes);
    sub.focus = focus;
    this.notify();
  }

  remove(id: number): void {
    if (this.subs.delete(id)) this.notify();
  }

  /** 广播给所有订阅者；行情事件只发给真正订阅了该品种的连接。 */
  broadcast(event: StreamEvent): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const sub of this.subs.values()) {
      if (event.type === 'quote' && !sub.codes.has(event.quote.code)) continue;
      // K 线只推给正在看这个品种的连接
      if (event.type === 'kline' && sub.focus !== event.code) continue;
      try {
        sub.res.write(payload);
      } catch {
        this.subs.delete(sub.id);
      }
    }
  }

  sendTo(id: number, event: StreamEvent): void {
    const sub = this.subs.get(id);
    if (!sub) return;
    try {
      sub.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      this.subs.delete(id);
    }
  }

  closeAll(): void {
    for (const sub of this.subs.values()) {
      try {
        sub.res.end();
      } catch {
        /* ignore */
      }
    }
    this.subs.clear();
  }
}
