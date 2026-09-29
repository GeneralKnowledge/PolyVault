import type {
  GDriveProviderConfig,
  OneDriveProviderConfig,
  ProviderConfig,
  RelayConfig,
} from "../config/types.js";

export interface RelayReplicateRequest {
  sourceUrl: string;
  remotePath: string;
  size?: number;
  contentType?: string;
  destination: ProviderConfig;
}

export interface RelayReplicateResponse {
  ok: boolean;
  destination?: string;
  error?: string;
}

/**
 * Ask a free-tier relay VM to pull from the hub URL and push to a cloud replica.
 * Tokens travel only to your own relay (Oracle Always Free, etc.).
 */
export async function replicateViaRelay(
  relay: RelayConfig,
  request: RelayReplicateRequest,
): Promise<RelayReplicateResponse> {
  if (!relay.url) throw new Error("Relay URL not configured");
  if (!relay.token) throw new Error("Relay token not configured");

  const base = relay.url.replace(/\/+$/, "");
  const res = await fetch(`${base}/v1/replicate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${relay.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  const text = await res.text();
  let parsed: RelayReplicateResponse;
  try {
    parsed = JSON.parse(text) as RelayReplicateResponse;
  } catch {
    throw new Error(`Relay returned non-JSON (${res.status}): ${text}`);
  }

  if (!res.ok || !parsed.ok) {
    throw new Error(parsed.error ?? `Relay failed with HTTP ${res.status}`);
  }
  return parsed;
}

export type CloudOAuthConfig = GDriveProviderConfig | OneDriveProviderConfig;
