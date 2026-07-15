export interface AdapterLimit {
  concurrency: number;
  minIntervalMs: number;
}

class Limiter {
  private active = 0;
  private lastStartedAt = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: AdapterLimit) {
    if (!Number.isInteger(limit.concurrency) || limit.concurrency < 1) throw new Error("adapter concurrency must be positive");
    if (limit.minIntervalMs < 0) throw new Error("adapter interval cannot be negative");
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      const waitMs = Math.max(0, this.lastStartedAt + this.limit.minIntervalMs - Date.now());
      if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      this.lastStartedAt = Date.now();
      return await operation();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active >= this.limit.concurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
  }
}

export class AdapterLimiterSet<K extends string = string> {
  private readonly limiters = new Map<K, Limiter>();

  constructor(config: Readonly<Record<K, AdapterLimit>>) {
    for (const [key, limit] of Object.entries(config) as Array<[K, AdapterLimit]>) {
      this.limiters.set(key, new Limiter(limit));
    }
  }

  async run<T>(adapter: K, operation: () => Promise<T>): Promise<T> {
    const limiter = this.limiters.get(adapter);
    if (!limiter) throw new Error(`adapter limiter is not configured: ${adapter}`);
    return limiter.run(operation);
  }
}
