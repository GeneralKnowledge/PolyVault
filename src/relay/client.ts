import type { ProviderConfig, RelayConfig } from "../config/types.js";

export interface RelayReplicateRequest {
  sourceUrl: string;
  remotePath: string;
  size?: number;
  contentType?: string;
  destinations: ProviderConfig[];
  options?: {
    retries?: number;
    skipIfSameSize?: boolean;
  };
}

export interface RelayDestResult {
  name: string;
  kind: string;
  ok: boolean;
  skipped?: boolean;
  destination?: string;
  error?: string;
}

export interface RelayReplicateResponse {
  ok: boolean;
  results: RelayDestResult[];
  error?: string;
}

/**
 * Ask the free-tier relay to pull the hub object once and push to many
 * destinations in parallel.
 */
export async function replicateViaRelay(
  relay: RelayConfig,
  request: RelayReplicateRequest,
): Promise<RelayReplicateResponse> {
  if (!relay.url) throw new Error("Relay URL not configured");
  if (!relay.token) throw new Error("Relay token not configured");
  if (!request.destinations.length) {
    throw new Error("No destinations for relay");
  }

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

  if (!parsed.results) {
    parsed.results = [];
  }

  // Don't throw on partial failure — caller maps per-destination results.
  if (!res.ok && parsed.results.length === 0) {
    throw new Error(parsed.error ?? `Relay failed with HTTP ${res.status}`);
  }
  return parsed;
}
