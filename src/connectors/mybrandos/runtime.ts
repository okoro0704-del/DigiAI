import type { ConnectorCallResult } from "../fixtures.js";
import type { DigiAiToolOperation } from "../../contracts/connectors.js";
import { toolResponseDigest } from "../digest.js";
import { requestMybrandosAuthenticated, type MybrandosClientConfig } from "./client.js";

export const mybrandosReadStats = {
  submissions: 0,
  retries: 0,
  lastMethod: "",
  lastPath: "",
  lastAuthenticated: false,
};

export function resetMybrandosReadStats() {
  mybrandosReadStats.submissions = 0;
  mybrandosReadStats.retries = 0;
  mybrandosReadStats.lastMethod = "";
  mybrandosReadStats.lastPath = "";
  mybrandosReadStats.lastAuthenticated = false;
}

let override: ((operation: "inspectPublicDigitalLife" | "listPublishedAssets", slug: string) => Promise<ReturnType<typeof requestMybrandosAuthenticated>>) | undefined;
let boundConfig: MybrandosClientConfig | undefined;

export function bindMybrandosReadClient(input: {
  config?: MybrandosClientConfig;
  request?: typeof override;
}) {
  boundConfig = input.config;
  override = input.request;
}

export function resetMybrandosReadClient() {
  boundConfig = undefined;
  override = undefined;
}

export function mybrandosClientConfig(): MybrandosClientConfig | undefined {
  return boundConfig;
}

export async function runMybrandosConnector(input: {
  operation: DigiAiToolOperation;
  slug: string;
  serviceSecret?: string;
  config?: MybrandosClientConfig;
}): Promise<ConnectorCallResult> {
  const op = input.operation.operationName === "listPublishedAssets" ? "listPublishedAssets" : "inspectPublicDigitalLife";
  mybrandosReadStats.submissions += 1;
  mybrandosReadStats.lastMethod = "GET";
  mybrandosReadStats.lastPath = op === "listPublishedAssets"
    ? `/api/internal/digital-life/${input.slug}/assets`
    : `/api/internal/digital-life/${input.slug}`;
  mybrandosReadStats.lastAuthenticated = Boolean(input.serviceSecret) || Boolean(override);
  const config = input.config ?? boundConfig;
  if (!override && !input.serviceSecret) {
    return {
      status: "FAILED",
      submitted: false,
      failureCode: "AUTHENTICATION_ERROR",
      evidence: { system: "mybrandos", reasonCode: "MYBRANDOS_AUTH_FAILED", httpStatus: "401", attempts: "0", fallback: "denied" },
    };
  }
  if (!override && !config?.baseUrl) {
    return {
      status: "FAILED",
      submitted: false,
      failureCode: "TEMPORARY_UNAVAILABLE",
      evidence: { system: "mybrandos", reasonCode: "MYBRANDOS_UNAVAILABLE", httpStatus: "0", attempts: "0" },
    };
  }
  const result = override
    ? await override(op, input.slug)
    : await requestMybrandosAuthenticated({
        config: config!,
        slug: input.slug,
        operation: op,
        serviceSecret: input.serviceSecret!,
      });
  if (!result.ok) {
    if (result.attempts > 1) mybrandosReadStats.retries += 1;
    const failureCode =
      result.code === "MYBRANDOS_TIMEOUT"
        ? "TIMEOUT_BEFORE_SUBMISSION"
        : result.code === "MYBRANDOS_RATE_LIMITED"
          ? "RATE_LIMITED"
          : result.code === "MYBRANDOS_MALFORMED_RESPONSE"
            ? "MALFORMED_RESPONSE"
            : result.code === "MYBRANDOS_AUTH_FAILED"
              ? "AUTHENTICATION_ERROR"
              : result.code === "MYBRANDOS_ACCESS_DENIED"
                ? "AUTHORIZATION_ERROR"
                : result.code === "MYBRANDOS_NOT_FOUND"
                  ? "PROVIDER_REJECTED"
                  : "TEMPORARY_UNAVAILABLE";
    return {
      status: "FAILED",
      submitted: result.code !== "MYBRANDOS_TIMEOUT" && result.code !== "MYBRANDOS_UNAVAILABLE",
      failureCode,
      evidence: {
        system: "mybrandos",
        reasonCode: result.code,
        httpStatus: String(result.status),
        attempts: String(result.attempts),
        s2sAuthenticated: "false",
        fallback: "denied",
      },
    };
  }
  const output = result.body as unknown as Record<string, unknown>;
  return {
    status: "SUCCEEDED",
    submitted: true,
    externalOperationRef: `mybrandos:s2s:${result.body.slug}`,
    resultReference: `mybrandos:s2s:${result.body.slug}:${result.body.publishedAssetCount}`,
    evidence: {
      system: "mybrandos",
      operation: op,
      slug: result.body.slug,
      publishedAssetCount: String(result.body.publishedAssetCount),
      privacyClass: "PUBLIC",
      factKind: "SOURCE_FACT",
      s2sAuthenticated: "true",
      authenticationMode: "S2S_SECRET",
      responseDigest: toolResponseDigest(output),
      retrievedAt: result.body.retrievedAt,
    },
    output,
  };
}
