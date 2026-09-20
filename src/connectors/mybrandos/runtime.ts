import type { ConnectorCallResult } from "../fixtures.js";
import type { DigiAiToolOperation } from "../../contracts/connectors.js";
import { toolResponseDigest } from "../digest.js";
import { requestMybrandosAuthenticated, type MybrandosClientConfig } from "./client.js";
import { reconcileMybrandosDraft, requestMybrandosCreateDraft } from "./write-client.js";

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
let writeOverride: ((input: {
  reconcile?: boolean;
  ownerId: string;
  title: string;
  idempotencyKey: string;
  payloadDigest: string;
}) => Promise<import("./write-client.js").MybrandosWriteResult>) | undefined;
let boundConfig: MybrandosClientConfig | undefined;

export function bindMybrandosReadClient(input: {
  config?: MybrandosClientConfig;
  request?: typeof override;
  write?: typeof writeOverride;
}) {
  if (input.config) boundConfig = input.config;
  if (input.request) override = input.request;
  if (input.write) writeOverride = input.write;
}

export function bindMybrandosWriteClient(input: { write?: typeof writeOverride; config?: MybrandosClientConfig }) {
  if (input.config) boundConfig = input.config;
  writeOverride = input.write;
}

export function resetMybrandosReadClient() {
  boundConfig = undefined;
  override = undefined;
  writeOverride = undefined;
}

export function mybrandosClientConfig(): MybrandosClientConfig | undefined {
  return boundConfig;
}

export async function runMybrandosCreateDraft(input: {
  operation: DigiAiToolOperation;
  serviceSecret?: string;
  config?: MybrandosClientConfig;
  ownerId: string;
  title: string;
  description?: string;
  idempotencyKey: string;
  payloadDigest: string;
  reconcile?: boolean;
}): Promise<ConnectorCallResult> {
  const config = input.config ?? boundConfig;
  if (writeOverride) {
    const result = await writeOverride({
      reconcile: input.reconcile,
      ownerId: input.ownerId,
      title: input.title,
      idempotencyKey: input.idempotencyKey,
      payloadDigest: input.payloadDigest,
    });
    if (!result.ok) {
      if (result.code === "MYBRANDOS_TIMEOUT" || result.code === "MYBRANDOS_MALFORMED_RESPONSE") {
        return {
          status: "UNKNOWN_OUTCOME",
          submitted: result.submitted,
          failureCode: result.code === "MYBRANDOS_TIMEOUT" ? "TIMEOUT_UNKNOWN_SUBMISSION" : "MALFORMED_RESPONSE",
          evidence: { system: "mybrandos", reasonCode: result.code, fallback: "denied" },
        };
      }
      return {
        status: "FAILED",
        submitted: result.submitted,
        failureCode: result.code === "MYBRANDOS_AUTH_FAILED" ? "AUTHENTICATION_ERROR" : "PROVIDER_REJECTED",
        evidence: { system: "mybrandos", reasonCode: result.code, fallback: "denied" },
      };
    }
    const output = result.body as unknown as Record<string, unknown>;
    return {
      status: "SUCCEEDED",
      submitted: true,
      externalOperationRef: `mybrandos:draft:${result.body.draftId}`,
      resultReference: `mybrandos:draft:${result.body.draftId}:${result.body.state}`,
      evidence: {
        system: "mybrandos",
        operation: "createDraft",
        draftId: result.body.draftId,
        state: result.body.state,
        ownerRef: result.body.ownerRef,
        createdAt: result.body.createdAt,
        contentDigest: result.body.contentDigest,
        idempotencyKeyRef: result.body.idempotencyKeyRef,
        privacyClass: "PRIVATE",
        published: "false",
        scheduled: "false",
        distributed: "false",
        s2sAuthenticated: "true",
        authenticationMode: "S2S_SECRET",
        responseDigest: toolResponseDigest(output),
      },
      output,
    };
  }
  if (!input.serviceSecret) {
    return {
      status: "FAILED",
      submitted: false,
      failureCode: "AUTHENTICATION_ERROR",
      evidence: { system: "mybrandos", reasonCode: "MYBRANDOS_AUTH_FAILED", fallback: "denied" },
    };
  }
  if (!config?.baseUrl) {
    return {
      status: "FAILED",
      submitted: false,
      failureCode: "TEMPORARY_UNAVAILABLE",
      evidence: { system: "mybrandos", reasonCode: "MYBRANDOS_UNAVAILABLE" },
    };
  }
  const result = input.reconcile
    ? await reconcileMybrandosDraft({
        config,
        serviceSecret: input.serviceSecret,
        ownerId: input.ownerId,
        idempotencyKey: input.idempotencyKey,
        payloadDigest: input.payloadDigest,
      })
    : await requestMybrandosCreateDraft({
        config,
        serviceSecret: input.serviceSecret,
        ownerId: input.ownerId,
        title: input.title,
        description: input.description,
        idempotencyKey: input.idempotencyKey,
        payloadDigest: input.payloadDigest,
      });
  if (!result.ok) {
    if (result.code === "MYBRANDOS_TIMEOUT" || result.code === "MYBRANDOS_MALFORMED_RESPONSE") {
      return {
        status: "UNKNOWN_OUTCOME",
        submitted: result.submitted,
        failureCode: result.code === "MYBRANDOS_TIMEOUT" ? "TIMEOUT_UNKNOWN_SUBMISSION" : "MALFORMED_RESPONSE",
        evidence: { system: "mybrandos", reasonCode: result.code, httpStatus: String(result.status), s2sAuthenticated: "true", fallback: "denied" },
      };
    }
    if (input.reconcile && result.code === "MYBRANDOS_NOT_FOUND") {
      return {
        status: "UNKNOWN_OUTCOME",
        submitted: false,
        failureCode: "TIMEOUT_UNKNOWN_SUBMISSION",
        evidence: { system: "mybrandos", reasonCode: "NOT_FOUND", reconciled: "true" },
      };
    }
    const failureCode =
      result.code === "MYBRANDOS_AUTH_FAILED"
        ? "AUTHENTICATION_ERROR"
        : result.code === "MYBRANDOS_ACCESS_DENIED" || result.code === "SCOPE_INSUFFICIENT"
          ? "AUTHORIZATION_ERROR"
          : result.code === "IDEMPOTENCY_CONFLICT"
            ? "PARAMETER_MISMATCH"
            : result.code === "INVALID_DRAFT_INPUT"
              ? "VALIDATION_ERROR"
              : result.code === "MYBRANDOS_UNAVAILABLE"
                ? "TEMPORARY_UNAVAILABLE"
                : "PROVIDER_REJECTED";
    return {
      status: "FAILED",
      submitted: result.submitted,
      failureCode,
      evidence: { system: "mybrandos", reasonCode: result.code, httpStatus: String(result.status), fallback: "denied" },
    };
  }
  const output = result.body as unknown as Record<string, unknown>;
  return {
    status: "SUCCEEDED",
    submitted: true,
    externalOperationRef: `mybrandos:draft:${result.body.draftId}`,
    resultReference: `mybrandos:draft:${result.body.draftId}:${result.body.state}`,
    evidence: {
      system: "mybrandos",
      operation: "createDraft",
      draftId: result.body.draftId,
      state: result.body.state,
      ownerRef: result.body.ownerRef,
      createdAt: result.body.createdAt,
      contentDigest: result.body.contentDigest,
      idempotencyKeyRef: result.body.idempotencyKeyRef,
      privacyClass: "PRIVATE",
      published: "false",
      scheduled: "false",
      distributed: "false",
      s2sAuthenticated: "true",
      authenticationMode: "S2S_SECRET",
      responseDigest: toolResponseDigest(output),
    },
    output,
  };
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
