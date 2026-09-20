import type { AppConfig } from "../config.js";
import type { SecureCredentialBackend } from "./backend.js";
import { MemorySecureCredentialBackend } from "./memory.js";
import { RailwayPlatformServiceBackend } from "./railway.js";

let bound: SecureCredentialBackend | undefined;

export function createSecureCredentialBackend(config: AppConfig): SecureCredentialBackend {
  if (config.isProd) return new RailwayPlatformServiceBackend();
  return new MemorySecureCredentialBackend();
}

export function bindSecureCredentialBackend(backend: SecureCredentialBackend) {
  bound = backend;
  return backend;
}

export function currentSecureCredentialBackend(): SecureCredentialBackend {
  if (!bound) bound = new MemorySecureCredentialBackend();
  return bound;
}

export function resetSecureCredentialBackend() {
  if (bound instanceof MemorySecureCredentialBackend) bound.reset();
  bound = undefined;
}

export function credentialHealth(backend: SecureCredentialBackend = currentSecureCredentialBackend()): {
  secureBackend: { configured: true; type: "railway-platform-service" | "memory-fixture-only" };
  connections: { supported: true };
  oauthFoundation: { supported: true };
  rotation: { supported: true };
  revocation: { supported: true };
  secretResolution: { serverSideOnly: true };
  realConsequentialActions: { enabled: false };
  dynamicUserOAuthVault: { supported: boolean };
  platformServiceCredentials: { supported: boolean };
} {
  return {
    secureBackend: {
      configured: true,
      type: backend.backendClass,
    },
    connections: { supported: true },
    oauthFoundation: { supported: true },
    rotation: { supported: true },
    revocation: { supported: true },
    secretResolution: { serverSideOnly: true },
    realConsequentialActions: { enabled: false },
    dynamicUserOAuthVault: { supported: backend.supportsDynamicUserVault },
    platformServiceCredentials: { supported: backend.supportsPlatformService },
  };
}
