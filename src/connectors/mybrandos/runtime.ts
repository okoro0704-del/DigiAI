import type { ConnectorCallResult } from "../fixtures.js";
import type { DigiAiToolOperation } from "../../contracts/connectors.js";
import { toolResponseDigest } from "../digest.js";
import { requestMybrandosPublic, type MybrandosClientConfig } from "./client.js";

export const mybrandosReadStats = {
  submissions: 0,
  retries: 0,
  lastMethod: "",
  lastPath: "",
};

export function resetMybrandosReadStats() {
  mybrandosReadStats.submissions = 0;
  mybrandosReadStats.retries = 0;
  mybrandosReadStats.lastMethod = "";
  mybrandosReadStats.lastPath = "";
}

let override: ((operation: "inspectPublicDigitalLife" | "listPublishedAssets", slug: string) => Promise<ReturnType<typeof requestMybrandosPublic>>) | undefined;
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
  config?: MybrandosClientConfig;
}): Promise<ConnectorCallResult> {
  const op = input.operation.operationName === "listPublishedAssets" ? "listPublishedAssets" : "inspectPublicDigitalLife";
  mybrandosReadStats.submissions += 1;
  mybrandosReadStats.lastMethod = "GET";
  mybrandosReadStats.lastPath = op === "listPublishedAssets" ? `/api/public/${input.slug}/assets` : `/api/public/${input.slug}`;
  const config = input.config ?? boundConfig;
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
    : await requestMybrandosPublic({
        config: config!,
        slug: input.slug,
        operation: op,
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
            : result.code === "MYBRANDOS_ACCESS_DENIED" || result.code === "MYBRANDOS_AUTH_FAILED"
              ? "AUTHORIZATION_ERROR"
              : result.code === "MYBRANDOS_NOT_FOUND"
                ? "PROVIDER_REJECTED"
                : "TEMPORARY_UNAVAILABLE";
    return {
      status: result.code === "MYBRANDOS_TIMEOUT" ? "FAILED" : "FAILED",
      submitted: result.code !== "MYBRANDOS_TIMEOUT" && result.code !== "MYBRANDOS_UNAVAILABLE",
      failureCode,
      evidence: {
        system: "mybrandos",
        reasonCode: result.code,
        httpStatus: String(result.status),
        attempts: String(result.attempts),
      },
    };
  }
  const output = result.body as unknown as Record<string, unknown>;
  return {
    status: "SUCCEEDED",
    submitted: true,
    externalOperationRef: `mybrandos:public:${result.body.slug}`,
    resultReference: `mybrandos:public:${result.body.slug}:${result.body.publishedAssetCount}`,
    evidence: {
      system: "mybrandos",
      operation: op,
      slug: result.body.slug,
      publishedAssetCount: String(result.body.publishedAssetCount),
      privacyClass: "PUBLIC",
      factKind: "SOURCE_FACT",
      responseDigest: toolResponseDigest(output),
      retrievedAt: result.body.retrievedAt,
    },
    output,
  };
}
