#!/usr/bin/env node

import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loginWithJwt } from "./auth/jwt.js";
import { loginWithPkce } from "./auth/pkce.js";
import { runApplySchemaCli } from "./cli/apply-schema.js";
import { loadConfig } from "./lib/config.js";
import { createMcpServer } from "./mcp/server.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "login":
      {
        const config = loadConfig();
      if (config.authMode === "pkce") {
        await loginWithPkce(config);
      } else {
        await loginWithJwt(config);
      }
      return;
      }
    case "serve": {
      const config = loadConfig();
      const server = createMcpServer(config);
      const transport = new StdioServerTransport();
      await server.connect(transport);
      return;
    }
    case "apply-schema":
      {
        const config = loadConfig();
      await runApplySchemaCli(config, args);
      return;
      }
    default:
      printUsage();
      process.exitCode = 1;
  }
}

function printUsage(): void {
  process.stderr.write(
    [
      "Usage:",
      "  salesforce-mcp login",
      "  salesforce-mcp serve",
      "  salesforce-mcp apply-schema <file> [--dry-run]",
      "",
      "Environment:",
      "  SF_LOGIN_URL        default https://login.salesforce.com",
      "  SF_CLIENT_ID        required",
      "  SF_AUTH_MODE        pkce | jwt",
      "  SF_REDIRECT_PORT    default 8788",
      "  SF_JWT_PRIVATE_KEY_PATH, SF_USERNAME for jwt mode",
      "  SF_ALLOW_WRITE=1    enables delete_record",
      "  SF_ALLOW_METADATA=1 enables schema mutations",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
