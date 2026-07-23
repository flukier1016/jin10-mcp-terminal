/**
 * 极简 TTL 缓存 + 在途请求合并。
 *
 * 合并在途请求这件事在这里不是优化而是必需：同一秒钟 10 个页面点开同一根 K 线，
 * 如果不合并就是 10 次真实调用，直接吃掉当天 0.7% 的额度。
 */
interface Entry<T> {
  value: T;
  expires: number;
}

export class TtlCache {
  private store = new Map<string, Entry<unknown>>();
  private inflight = new Map<string, Promise<unknown>>();

  get<T>(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expires: Date.now() + ttlMs });
    if (this.store.size > 500) this.evict();
  }

  async wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;

    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const p = fn()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p;
  }

  private evict(): void {
    const now = Date.now();
    for (const [k, v] of this.store) if (v.expires < now) this.store.delete(k);
  }
}
