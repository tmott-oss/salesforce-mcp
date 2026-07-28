import { readFile } from "node:fs/promises";
import { SignJWT, importPKCS8 } from "jose";
import jsforce from "jsforce";
import type { AppConfig } from "../lib/config.js";
import { saveSession } from "./session-store.js";

const JWT_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";

export async function loginWithJwt(config: AppConfig): Promise<void> {
  const conn = new jsforce.Connection({
    loginUrl: config.loginUrl,
    oauth2: {
      loginUrl: config.loginUrl,
      clientId: config.clientId,
    },
  });

  const assertion = await createJwtAssertion(config);
  const userInfo = await conn.authorize({
    grant_type: JWT_GRANT_TYPE,
    assertion,
  });

  await saveSession(config.tokenPath, {
    authMode: "jwt",
    loginUrl: config.loginUrl,
    clientId: config.clientId,
    instanceUrl: conn.instanceUrl,
    accessToken: conn.accessToken ?? "",
    username: config.username,
    idUrl: userInfo.url,
    userInfo: {
      id: userInfo.id,
      organizationId: userInfo.organizationId,
      url: userInfo.url,
    },
    updatedAt: new Date().toISOString(),
  });

  console.error(`Saved Salesforce JWT session to ${config.tokenPath}`);
}

export async function createJwtAssertion(config: AppConfig): Promise<string> {
  const privateKeyPem = await readFile(config.jwtPrivateKeyPath!, "utf8");
  const key = await importPKCS8(privateKeyPem, "RS256");
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(config.clientId)
    .setSubject(config.username!)
    .setAudience(config.loginUrl)
    .setIssuedAt(now)
    .setExpirationTime(now + 180)
    .sign(key);
}
