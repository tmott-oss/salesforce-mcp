import http from "node:http";
import { randomBytes } from "node:crypto";
import { URL } from "node:url";
import jsforce from "jsforce";
import open from "open";
import type { AppConfig } from "../lib/config.js";
import { saveSession } from "./session-store.js";

export async function loginWithPkce(config: AppConfig): Promise<void> {
  const oauth2 = new jsforce.OAuth2({
    loginUrl: config.loginUrl,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    useVerifier: true,
  });

  const state = randomBytes(24).toString("hex");
  const authUrl = oauth2.getAuthorizationUrl({
    scope: "api refresh_token web",
    state,
  });

  const code = await waitForOAuthCode(config.redirectPort, state, config.redirectUri, authUrl);
  const conn = new jsforce.Connection({ oauth2, loginUrl: config.loginUrl });
  const userInfo = await conn.authorize(code);

  await saveSession(config.tokenPath, {
    authMode: "pkce",
    loginUrl: config.loginUrl,
    clientId: config.clientId,
    instanceUrl: conn.instanceUrl,
    accessToken: conn.accessToken ?? "",
    refreshToken: conn.refreshToken ?? undefined,
    scope: undefined,
    idUrl: userInfo.url,
    userInfo: {
      id: userInfo.id,
      organizationId: userInfo.organizationId,
      url: userInfo.url,
    },
    updatedAt: new Date().toISOString(),
  });

  console.error(`Saved Salesforce session to ${config.tokenPath}`);
}

async function waitForOAuthCode(
  port: number,
  expectedState: string,
  redirectUri: string,
  authUrl: string,
): Promise<string> {
  console.error(`Add this callback URL to your Salesforce External Client App if needed:\n${redirectUri}`);
  console.error(`Opening browser for Salesforce login.\nIf it does not open, paste this URL into a browser:\n${authUrl}`);

  try {
    await open(authUrl);
  } catch {
    // Best effort only; URL is already printed for manual use.
  }

  return new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.statusCode = 400;
        res.end("Missing request URL.");
        return;
      }

      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== "/oauth/callback") {
        res.statusCode = 404;
        res.end("Not found.");
        return;
      }

      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");

      if (error) {
        res.statusCode = 400;
        res.end(`Salesforce OAuth error: ${errorDescription ?? error}`);
        server.close();
        reject(new Error(`Salesforce OAuth error: ${errorDescription ?? error}`));
        return;
      }

      if (state !== expectedState) {
        res.statusCode = 400;
        res.end("State mismatch.");
        server.close();
        reject(new Error("OAuth state mismatch"));
        return;
      }

      if (!code) {
        res.statusCode = 400;
        res.end("Missing authorization code.");
        server.close();
        reject(new Error("Missing OAuth authorization code"));
        return;
      }

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<h1>Salesforce login complete</h1><p>You can close this tab.</p>");
      server.close();
      resolve(code);
    });

    server.on("error", reject);
    server.listen(port);
  });
}
