import { externalFailure } from "@tk/contracts";
import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

export interface EnvAwareFetchDeps {
  readonly createDispatcher?: (options: EnvHttpProxyAgent.Options) => Dispatcher;
  readonly transport?: typeof undiciFetch;
}

export type EnvAwareFetch = typeof fetch & { close(): Promise<void> };

export function createEnvAwareFetch(
  env: NodeJS.ProcessEnv = process.env,
  deps: EnvAwareFetchDeps = {}
): EnvAwareFetch {
  const createDispatcher = deps.createDispatcher ?? ((options) => new EnvHttpProxyAgent(options));
  let dispatcher: Dispatcher;
  try {
    dispatcher = createDispatcher({
      httpProxy: env.http_proxy ?? env.HTTP_PROXY ?? "",
      httpsProxy: env.https_proxy ?? env.HTTPS_PROXY ?? "",
      noProxy: env.no_proxy ?? env.NO_PROXY ?? ""
    });
  } catch {
    throw externalFailure("needs_input", "adapter.proxy_invalid", "External HTTP proxy configuration is invalid");
  }
  const transport = deps.transport ?? undiciFetch;
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => transport(input as Parameters<typeof undiciFetch>[0], {
    ...init,
    dispatcher
  } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>) as typeof fetch;
  return Object.assign(fetchImpl, { close: () => dispatcher.close() });
}
