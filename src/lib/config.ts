import path from "node:path";
import { z } from "zod";

const authModeSchema = z.enum(["pkce", "jwt"]);

const envSchema = z.object({
  SF_LOGIN_URL: z.string().url().default("https://login.salesforce.com"),
  SF_CLIENT_ID: z.string().min(1, "SF_CLIENT_ID is required"),
  SF_AUTH_MODE: authModeSchema.default("pkce"),
  SF_REDIRECT_PORT: z.coerce.number().int().positive().default(8788),
  SF_JWT_PRIVATE_KEY_PATH: z.string().optional(),
  SF_USERNAME: z.string().optional(),
  SF_ALLOW_WRITE: z.string().optional(),
  SF_ALLOW_METADATA: z.string().optional(),
  SF_TOKEN_PATH: z.string().optional(),
});

export interface AppConfig {
  loginUrl: string;
  clientId: string;
  authMode: "pkce" | "jwt";
  redirectPort: number;
  redirectUri: string;
  jwtPrivateKeyPath?: string;
  username?: string;
  allowWrite: boolean;
  allowMetadata: boolean;
  tokenPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);

  if (parsed.SF_AUTH_MODE === "jwt") {
    if (!parsed.SF_JWT_PRIVATE_KEY_PATH) {
      throw new Error("SF_JWT_PRIVATE_KEY_PATH is required when SF_AUTH_MODE=jwt");
    }
    if (!parsed.SF_USERNAME) {
      throw new Error("SF_USERNAME is required when SF_AUTH_MODE=jwt");
    }
  }

  const redirectUri = `http://localhost:${parsed.SF_REDIRECT_PORT}/oauth/callback`;

  return {
    loginUrl: parsed.SF_LOGIN_URL,
    clientId: parsed.SF_CLIENT_ID,
    authMode: parsed.SF_AUTH_MODE,
    redirectPort: parsed.SF_REDIRECT_PORT,
    redirectUri,
    jwtPrivateKeyPath: parsed.SF_JWT_PRIVATE_KEY_PATH,
    username: parsed.SF_USERNAME,
    allowWrite: parsed.SF_ALLOW_WRITE === "1",
    allowMetadata: parsed.SF_ALLOW_METADATA === "1",
    tokenPath:
      parsed.SF_TOKEN_PATH ??
      path.join(process.cwd(), ".sf-auth.json"),
  };
}
