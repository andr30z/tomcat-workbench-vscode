import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch, type Dispatcher } from 'undici';

// Explicit TLS verification also protects against an insecure parent Node environment.
const tls = { rejectUnauthorized: true };
let dispatcher: Dispatcher | undefined;
export function configureNetwork(proxy?: string): void {
  const previous = dispatcher;
  const options = { requestTls: tls, proxyTls: tls, connect: tls };
  dispatcher = proxy ? new ProxyAgent({ uri: proxy, ...options }) : process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy ? new EnvHttpProxyAgent(options) : new Agent({ connect: tls });
  void previous?.close();
}
export function networkFetch(url: string, timeout: number) {
  if (!dispatcher) configureNetwork();
  return fetch(url, { dispatcher, signal: AbortSignal.timeout(timeout) });
}
