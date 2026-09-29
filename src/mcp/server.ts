import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../lib/config.js";
import { getSalesforceConnection } from "../lib/salesforce.js";
import {
  addPicklistValues,
  applySchemaFile,
  createOrUpdateCustomField,
  createOrUpdateCustomObject,
  ensureMetadataAllowed,
} from "../schema/metadata.js";

export function createMcpServer(config: AppConfig): McpServer {
  const server = new McpServer(
    {
      name: "salesforce-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        "Use these tools to query Salesforce data, describe objects, modify records, and manage custom schema through Salesforce REST, Tooling, and Metadata APIs.",
    },
  );

  server.registerTool(
    "soql_query",
    {
      description: "Run a SOQL query against Salesforce and return rows.",
      inputSchema: {
        query: z.string().min(1),
      },
    },
    async ({ query }) => {
      const conn = await getSalesforceConnection(config);
      const result = await conn.query<Record<string, unknown>>(query, { autoFetch: true, maxFetch: 5000 });
      return jsonResult({
        totalSize: result.totalSize,
        done: result.done,
        records: result.records,
      });
    },
  );

  server.registerTool(
    "describe_sobject",
    {
      description: "Describe a Salesforce sObject and return fields plus metadata.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => {
      const conn = await getSalesforceConnection(config);
      const result = await conn.describe(name);
      return jsonResult(result);
    },
  );

  server.registerTool(
    "create_record",
    {
      description: "Create a Salesforce record.",
      inputSchema: {
        sobject: z.string().min(1),
        fields: z.record(z.unknown()),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ sobject, fields, dryRun }) => {
      ensureWriteAllowed(config, dryRun);
      if (dryRun) {
        return jsonResult({
          dryRun: true,
          action: "create_record",
          target: { sobject },
          fields,
        });
      }
      const conn = await getSalesforceConnection(config);
      const result = await conn.create(sobject as never, fields as never);
      return jsonResult(result);
    },
  );

  server.registerTool(
    "update_record",
    {
      description: "Update a Salesforce record by Id.",
      inputSchema: {
        sobject: z.string().min(1),
        id: z.string().min(1),
        fields: z.record(z.unknown()),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ sobject, id, fields, dryRun }) => {
      ensureWriteAllowed(config, dryRun);
      if (dryRun) {
        return jsonResult({
          dryRun: true,
          action: "update_record",
          target: { sobject, id },
          fields,
        });
      }
      const conn = await getSalesforceConnection(config);
      const result = await conn.update(sobject as never, { Id: id, ...fields } as never);
      return jsonResult(result);
    },
  );

  server.registerTool(
    "upsert_record",
    {
      description: "Upsert a Salesforce record using an external ID field.",
      inputSchema: {
        sobject: z.string().min(1),
        extIdField: z.string().min(1),
        rec: z.record(z.unknown()),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ sobject, extIdField, rec, dryRun }) => {
      ensureWriteAllowed(config, dryRun);
      if (dryRun) {
        return jsonResult({
          dryRun: true,
          action: "upsert_record",
          target: { sobject, extIdField },
          record: rec,
        });
      }
      const conn = await getSalesforceConnection(config);
      const result = await conn.sobject(sobject).upsert(rec, extIdField);
      return jsonResult(result);
    },
  );

  server.registerTool(
    "delete_record",
    {
      description: "Delete a Salesforce record by Id. Requires SF_ALLOW_WRITE=1 unless dryRun is true.",
      inputSchema: {
        sobject: z.string().min(1),
        id: z.string().min(1),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ sobject, id, dryRun }) => {
      if (!config.allowWrite && !dryRun) {
        throw new Error("delete_record is disabled. Set SF_ALLOW_WRITE=1 or use dryRun.");
      }

      if (dryRun) {
        return jsonResult({
          dryRun: true,
          action: "delete_record",
          target: { sobject, id },
        });
      }

      const conn = await getSalesforceConnection(config);
      const result = await conn.destroy(sobject as never, id);
      return jsonResult(result);
    },
  );

  server.registerTool(
    "create_custom_object",
    {
      description: "Create or upsert a custom object via Salesforce Metadata API.",
      inputSchema: {
        spec: z.object({
          apiName: z.string().min(1),
          label: z.string().min(1),
          pluralLabel: z.string().min(1),
          description: z.string().optional(),
          deploymentStatus: z.enum(["Deployed", "InDevelopment"]).optional(),
          sharingModel: z
            .enum(["ReadWrite", "ReadOnly", "Private", "ControlledByParent", "FullAccess"])
            .optional(),
          enableActivities: z.boolean().optional(),
          enableReports: z.boolean().optional(),
          enableSearch: z.boolean().optional(),
          enableHistory: z.boolean().optional(),
          nameField: z.object({
            label: z.string().min(1),
            type: z.enum(["Text", "AutoNumber"]),
            displayFormat: z.string().optional(),
          }),
        }),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ spec, dryRun }) => {
      ensureMetadataAllowed(config, dryRun);
      const conn = await getSalesforceConnection(config);
      const result = await createOrUpdateCustomObject(conn, config, spec, dryRun);
      return jsonResult({
        dryRun: Boolean(dryRun),
        payload: result.payload,
        result: result.result,
      });
    },
  );

  server.registerTool(
    "create_custom_field",
    {
      description: "Create or update a custom field on a standard or custom object via Metadata API.",
      inputSchema: {
        objectApiName: z.string().min(1),
        spec: z.object({
          apiName: z.string().min(1),
          label: z.string().min(1),
          type: z.enum([
            "Text",
            "LongTextArea",
            "Number",
            "Date",
            "DateTime",
            "Checkbox",
            "Url",
            "Picklist",
            "MultiselectPicklist",
            "Formula",
            "Lookup",
            "MasterDetail",
            "RollupSummary",
          ]),
          description: z.string().optional(),
          required: z.boolean().optional(),
          unique: z.boolean().optional(),
          externalId: z.boolean().optional(),
          defaultValue: z.string().optional(),
          inlineHelpText: z.string().optional(),
          relationshipLabel: z.string().optional(),
          relationshipName: z.string().optional(),
          reparentableMasterDetail: z.boolean().optional(),
          writeRequiresMasterRead: z.boolean().optional(),
          referenceTo: z.string().optional(),
          deleteConstraint: z.enum(["Clear", "Restrict", "SetNull"]).optional(),
          length: z.number().optional(),
          visibleLines: z.number().optional(),
          precision: z.number().optional(),
          scale: z.number().optional(),
          formula: z.string().optional(),
          formulaReturnType: z
            .enum(["Text", "Number", "Checkbox", "Date", "DateTime", "Currency", "Percent"])
            .optional(),
          formulaTreatBlanksAs: z.enum(["BlankAsBlank", "BlankAsZero"]).optional(),
          valueSet: z
            .object({
              restricted: z.boolean().optional(),
              sorted: z.boolean().optional(),
              values: z.array(
                z.object({
                  fullName: z.string().min(1),
                  label: z.string().optional(),
                  default: z.boolean().optional(),
                  isActive: z.boolean().optional(),
                  description: z.string().optional(),
                }),
              ),
            })
            .optional(),
          summaryOperation: z.enum(["Count", "Sum", "Min", "Max", "Avg"]).optional(),
          summarizedObject: z.string().optional(),
          summaryForeignKey: z.string().optional(),
          summarizedField: z.string().optional(),
        }),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ objectApiName, spec, dryRun }) => {
      ensureMetadataAllowed(config, dryRun);
      const conn = await getSalesforceConnection(config);
      const result = await createOrUpdateCustomField(conn, config, objectApiName, spec, dryRun);
      return jsonResult({
        dryRun: Boolean(dryRun),
        payload: result.payload,
        result: result.result,
      });
    },
  );

  server.registerTool(
    "add_picklist_values",
    {
      description: "Append values to an existing custom picklist field via Metadata API.",
      inputSchema: {
        objectApiName: z.string().min(1),
        fieldApiName: z.string().min(1),
        values: z.array(
          z.object({
            fullName: z.string().min(1),
            label: z.string().optional(),
            default: z.boolean().optional(),
            isActive: z.boolean().optional(),
            description: z.string().optional(),
          }),
        ),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ objectApiName, fieldApiName, values, dryRun }) => {
      ensureMetadataAllowed(config, dryRun);
      const conn = await getSalesforceConnection(config);
      const result = await addPicklistValues(conn, config, objectApiName, fieldApiName, values, dryRun);
      return jsonResult({
        dryRun: Boolean(dryRun),
        payload: result.payload,
        mergedValues: result.mergedValues,
        result: result.result,
      });
    },
  );

  server.registerTool(
    "apply_schema",
    {
      description: "Apply a JSON or YAML schema file idempotently via Salesforce Metadata API.",
      inputSchema: {
        schemaFile: z.string().min(1),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ schemaFile, dryRun }) => {
      ensureMetadataAllowed(config, dryRun);
      const conn = await getSalesforceConnection(config);
      const result = await applySchemaFile(conn, config, schemaFile, dryRun);
      return jsonResult(result);
    },
  );

  return server;
}

function ensureWriteAllowed(config: AppConfig, dryRun?: boolean): void {
  if (!config.allowWrite && !dryRun) {
    throw new Error("Record writes are disabled. Set SF_ALLOW_WRITE=1 or use dryRun.");
  }
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}
