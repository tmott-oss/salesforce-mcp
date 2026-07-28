import type { AppConfig } from "../lib/config.js";
import { getSalesforceConnection } from "../lib/salesforce.js";
import { applySchemaFile } from "../schema/metadata.js";

export async function runApplySchemaCli(config: AppConfig, args: string[]): Promise<void> {
  const schemaFile = args[0];
  const dryRun = args.includes("--dry-run");

  if (!schemaFile) {
    throw new Error("Usage: salesforce-mcp apply-schema <file> [--dry-run]");
  }

  const conn = await getSalesforceConnection(config);
  const result = await applySchemaFile(conn, config, schemaFile, dryRun);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
