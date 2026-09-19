import type { ProviderFailure } from "./types.js";

export function classifyProviderHttpError(
  status: number,
  body: { error?: { type?: string; code?: string; message?: string } } | null,
): Pick<ProviderFailure, "error" | "detail"> {
  const type = String(body?.error?.type ?? "").toLowerCase();
  const code = String(body?.error?.code ?? "").toLowerCase();
  const marker = `${type} ${code}`;
  if (status === 429 || marker.includes("rate_limit")) {
    return { error: "rate_limited", detail: "AI reasoning is temporarily rate limited." };
  }
  if (status === 402 || marker.includes("billing") || marker.includes("payment")) {
    return { error: "billing", detail: "AI reasoning needs provider billing attention." };
  }
  if (marker.includes("insufficient_quota") || marker.includes("quota")) {
    return { error: "quota", detail: "AI reasoning needs provider billing attention." };
  }
  if (status === 401 || status === 403) {
    return { error: "auth_failed", detail: "AI provider authentication failed." };
  }
  return { error: "provider_error", detail: "AI reasoning is temporarily unavailable." };
}

export function providerStateFromError(error: ProviderFailure["error"]): TwinProviderMapped {
  if (error === "unavailable") return { state: "unavailable", detail: "AI reasoning is temporarily unavailable." };
  if (error === "quota") return { state: "quota", detail: "AI reasoning needs provider billing attention." };
  if (error === "billing") return { state: "billing", detail: "AI reasoning needs provider billing attention." };
  if (error === "rate_limited") return { state: "rate_limited", detail: "AI reasoning is temporarily rate limited." };
  if (error === "auth_failed") return { state: "auth_failed", detail: "AI provider authentication failed." };
  if (error === "timeout") return { state: "unavailable", detail: "AI reasoning timed out." };
  return { state: "failed", detail: "AI reasoning is temporarily unavailable." };
}

type TwinProviderMapped = {
  state: "unavailable" | "quota" | "billing" | "rate_limited" | "auth_failed" | "failed";
  detail: string;
};
