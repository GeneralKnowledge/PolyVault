import { createServer } from "node:http";
import { URL } from "node:url";

export interface OAuthCallbackResult {
  code: string;
  state?: string;
}

/**
 * Start a one-shot localhost HTTP server that captures an OAuth redirect.
 * Default redirect URI: http://127.0.0.1:8765/callback
 */
export async function waitForOAuthCode(options: {
  port?: number;
  path?: string;
  timeoutMs?: number;
  expectedState?: string;
}): Promise<OAuthCallbackResult> {
  const port = options.port ?? 8765;
  const callbackPath = options.path ?? "/callback";
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        if (url.pathname !== callbackPath) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }

        const error = url.searchParams.get("error");
        if (error) {
          const desc = url.searchParams.get("error_description") ?? error;
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<html><body><h1>Authorization failed</h1><p>${desc}</p></body></html>`);
          cleanup();
          reject(new Error(`OAuth error: ${desc}`));
          return;
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state") ?? undefined;
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing code");
          return;
        }

        if (options.expectedState && state !== options.expectedState) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid state");
          cleanup();
          reject(new Error("OAuth state mismatch"));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h1>PolyVault authorized</h1><p>You can close this window and return to the terminal.</p></body></html>",
        );
        cleanup();
        resolve({ code, state });
      } catch (err) {
        cleanup();
        reject(err);
      }
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for OAuth callback"));
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      server.close();
    }

    server.on("error", (err) => {
      cleanup();
      reject(err);
    });

    server.listen(port, "127.0.0.1");
  });
}

export const DEFAULT_REDIRECT_URI = "http://127.0.0.1:8765/callback";
