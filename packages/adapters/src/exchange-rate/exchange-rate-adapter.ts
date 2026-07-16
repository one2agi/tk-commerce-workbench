import { externalFailure, type ExchangeRatePort, type ExchangeRateSnapshotWire } from "@tk/contracts";
import { isRetryableHttpStatus } from "../http-status.js";

export interface ExchangeRateAdapterConfig {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly staleAfterMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
}

export function createExchangeRateAdapter(config: ExchangeRateAdapterConfig): ExchangeRatePort {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const now = config.now ?? (() => new Date().toISOString());
  let latest: ExchangeRateSnapshotWire | null = null;
  return {
    async fetchSnapshot({ base, target }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000);
      let response: Response;
      try {
        const url = new URL(config.baseUrl);
        url.searchParams.set("base", base);
        url.searchParams.set("symbols", target);
        response = await fetchImpl(url, { signal: controller.signal });
      } catch {
        throw externalFailure("retryable", "exchange_rate.network", "Exchange-rate provider is temporarily unavailable");
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw externalFailure(isRetryableHttpStatus(response.status) ? "retryable" : "fatal", `exchange_rate.http_${response.status}`, "Exchange-rate provider request failed");
      let raw: { rates?: Record<string, unknown>; rate?: unknown; timestamp?: unknown; observedAt?: unknown };
      try { raw = await response.json() as typeof raw; } catch { throw externalFailure("fatal", "exchange_rate.invalid_response", "Exchange-rate provider returned invalid data"); }
      const rateValue = raw.rates?.[target] ?? raw.rate;
      const rate = typeof rateValue === "number" || typeof rateValue === "string" ? String(rateValue) : "";
      if (!isPositiveDecimal(rate)) throw externalFailure("fatal", "exchange_rate.invalid_response", "Exchange-rate provider returned invalid data");
      const observedAt = typeof raw.timestamp === "string" ? raw.timestamp : typeof raw.observedAt === "string" ? raw.observedAt : now();
      latest = withCurrentStaleness({ base, target, rate, source: "provider", observedAt, isStale: false }, now(), config.staleAfterMs ?? 86_400_000);
      return latest;
    },
    async latestSnapshot({ base, target }) {
      if (!latest || latest.base !== base || latest.target !== target) return null;
      latest = withCurrentStaleness(latest, now(), config.staleAfterMs ?? 86_400_000);
      return latest;
    },
    async recordManualOverride({ base, target, rate }) {
      if (!isPositiveDecimal(rate)) throw externalFailure("needs_input", "exchange_rate.invalid_manual_rate", "Manual exchange rate must be a positive decimal");
      latest = Object.freeze({ base, target, rate, source: "manual", observedAt: now(), isStale: false });
      return latest;
    }
  };
}

function withCurrentStaleness(snapshot: ExchangeRateSnapshotWire, currentTime: string, staleAfterMs: number): ExchangeRateSnapshotWire {
  const current = Date.parse(currentTime);
  const observed = Date.parse(snapshot.observedAt);
  const isStale = !Number.isFinite(current) || !Number.isFinite(observed) || current - observed > staleAfterMs;
  return Object.freeze({ ...snapshot, isStale });
}

function isPositiveDecimal(value: string): boolean {
  return /^(?:0\.(?:0*[1-9]\d*)|[1-9]\d*(?:\.\d+)?)$/.test(value);
}
