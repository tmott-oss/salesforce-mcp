import { readJsonFile, writeSecureJsonFile } from "../lib/files.js";

export interface SalesforceSession {
  authMode: "pkce" | "jwt";
  loginUrl: string;
  clientId: string;
  instanceUrl: string;
  accessToken: string;
  refreshToken?: string;
  scope?: string;
  issuedAt?: string;
  idUrl?: string;
  userInfo?: {
    id?: string;
    organizationId?: string;
    url?: string;
  };
  username?: string;
  updatedAt: string;
}

export async function loadSession(filePath: string): Promise<SalesforceSession | null> {
  return readJsonFile<SalesforceSession>(filePath);
}

export async function saveSession(filePath: string, session: SalesforceSession): Promise<void> {
  await writeSecureJsonFile(filePath, session);
}
