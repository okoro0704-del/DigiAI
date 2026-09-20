import { DigiAiError } from "../lib/http.js";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
]);

function isPrivateHost(host: string): boolean {
  if (BLOCKED_HOSTS.has(host.toLowerCase())) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(host)) return true;
  return false;
}

export function assertRegisteredDestination(input: {
  requested?: string;
  registered?: string;
  connectorType: string;
}) {
  if (!input.requested) return;
  throw new DigiAiError(403, "NETWORK_DESTINATION_DENIED", "Caller and model cannot supply a connector destination.");
}

export function assertSafeRedirect(fromHost: string, toHost: string) {
  if (fromHost.toLowerCase() !== toHost.toLowerCase()) {
    throw new DigiAiError(403, "NETWORK_DESTINATION_DENIED", "Authenticated connector redirects must stay on the registered host.");
  }
  if (isPrivateHost(toHost) ) {
    throw new DigiAiError(403, "NETWORK_DESTINATION_DENIED", "Redirects to private or metadata hosts are denied.");
  }
}

export function assertNotArbitraryNetwork(input: { host?: string; scheme?: string; port?: string | number; url?: string; baseUrl?: string }) {
  if (input.host || input.scheme || input.port || input.url || input.baseUrl) {
    throw new DigiAiError(403, "NETWORK_DESTINATION_DENIED", "Connector destinations are registry-bound. Arbitrary host, scheme, port, or URL is denied.");
  }
}

export function isPrivateInfrastructureHost(host: string): boolean {
  return isPrivateHost(host);
}
