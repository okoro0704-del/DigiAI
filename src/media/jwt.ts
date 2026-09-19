import { createHmac } from "node:crypto";

export type DriveJwtClaims = {
  userId: string;
  tenantId: string;
};

export function mintDriveJwt(input: {
  secret: string;
  issuer: string;
  audience: string;
  userId: string;
  tenantId: string;
  ttlSeconds?: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: input.issuer,
      aud: input.audience,
      sub: input.userId,
      tid: input.tenantId,
      iat: now,
      exp: now + (input.ttlSeconds ?? 300),
    }),
  );
  const data = `${header}.${payload}`;
  return `${data}.${createHmac("sha256", input.secret).update(data).digest("base64url")}`;
}

function b64url(value: string) {
  return Buffer.from(value).toString("base64url");
}

/** Decode tid without trusting the token as authorization. Drive still verifies. */
export function peekJwtTenant(token?: string): string | undefined {
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      tid?: unknown;
      tenantId?: unknown;
    };
    if (typeof payload.tid === "string" && payload.tid.trim()) return payload.tid.trim();
    if (typeof payload.tenantId === "string" && payload.tenantId.trim()) return payload.tenantId.trim();
    return undefined;
  } catch {
    return undefined;
  }
}
