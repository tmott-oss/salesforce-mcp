import jsforce from "jsforce";
import type { Connection } from "jsforce";
import type { AppConfig } from "./config.js";
import { createJwtAssertion } from "../auth/jwt.js";
import { loadSession, saveSession, type SalesforceSession } from "../auth/session-store.js";

const JWT_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";

export async function getSalesforceConnection(config: AppConfig): Promise<Connection> {
  const session = await loadSession(config.tokenPath);

  if (!session) {
    throw new Error(`No saved Salesforce session at ${config.tokenPath}. Run the login command first.`);
  }

  if (session.clientId !== config.clientId || session.loginUrl !== config.loginUrl || session.authMode !== config.authMode) {
    throw new Error(
      `Saved session does not match current env configuration. Re-run login.\nExpected ${config.authMode} ${config.loginUrl} ${config.clientId}.`,
    );
  }

  if (config.authMode === "pkce") {
    if (!session.refreshToken) {
      throw new Error("Saved PKCE session is missing a refresh token. Re-run login.");
    }

    const conn = new jsforce.Connection({
      loginUrl: config.loginUrl,
      instanceUrl: session.instanceUrl,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      oauth2: {
        loginUrl: config.loginUrl,
        clientId: config.clientId,
        redirectUri: config.redirectUri,
      },
      refreshFn: (refreshConn, callback) => {
        refreshConn.oauth2
          .refreshToken(refreshConn.refreshToken!)
          .then(async (res) => {
            refreshConn.instanceUrl = res.instance_url;
            await persistRefreshedSession(config, session, {
              accessToken: res.access_token,
              instanceUrl: res.instance_url,
              refreshToken: refreshConn.refreshToken!,
            });
            callback(null, res.access_token, res);
          })
          .catch((error) => callback(error as Error));
      },
    });

    conn.on("refresh", async (accessToken: string) => {
      await persistRefreshedSession(config, session, {
        accessToken,
        instanceUrl: conn.instanceUrl,
        refreshToken: conn.refreshToken ?? session.refreshToken,
      });
    });

    return conn;
  }

  const conn = new jsforce.Connection({
    loginUrl: config.loginUrl,
    instanceUrl: session.instanceUrl,
    accessToken: session.accessToken,
    oauth2: {
      loginUrl: config.loginUrl,
      clientId: config.clientId,
    },
    refreshFn: (refreshConn, callback) => {
      createJwtAssertion(config)
        .then((assertion) =>
          refreshConn.oauth2.requestToken({
            grant_type: JWT_GRANT_TYPE,
            assertion,
          }),
        )
        .then(async (res) => {
          refreshConn.instanceUrl = res.instance_url;
          await persistRefreshedSession(config, session, {
            accessToken: res.access_token,
            instanceUrl: res.instance_url,
          });
          callback(null, res.access_token, res);
        })
        .catch((error) => callback(error as Error));
    },
  });

  return conn;
}

async function persistRefreshedSession(
  config: AppConfig,
  current: SalesforceSession,
  next: {
    accessToken: string;
    instanceUrl: string;
    refreshToken?: string;
  },
): Promise<void> {
  await saveSession(config.tokenPath, {
    ...current,
    accessToken: next.accessToken,
    instanceUrl: next.instanceUrl,
    refreshToken: next.refreshToken ?? current.refreshToken,
    updatedAt: new Date().toISOString(),
  });
}
