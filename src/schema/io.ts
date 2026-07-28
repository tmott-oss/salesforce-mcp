import { readFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { SchemaFile } from "../types/schema.js";

const picklistValueSchema = z.object({
  fullName: z.string().min(1),
  label: z.string().optional(),
  default: z.boolean().optional(),
  isActive: z.boolean().optional(),
  description: z.string().optional(),
});

const customFieldSchema = z.object({
  apiName: z.string().min(1),
  label: z.string().min(1),
  type: z.string().min(1),
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
  deleteConstraint: z.string().optional(),
  length: z.number().optional(),
  visibleLines: z.number().optional(),
  precision: z.number().optional(),
  scale: z.number().optional(),
  formula: z.string().optional(),
  formulaReturnType: z
    .enum(["Text", "Number", "Checkbox", "Date", "DateTime", "Currency", "Percent"])
    .optional(),
  formulaTreatBlanksAs: z.string().optional(),
  valueSet: z
    .object({
      restricted: z.boolean().optional(),
      sorted: z.boolean().optional(),
      values: z.array(picklistValueSchema),
    })
    .optional(),
  summaryOperation: z.string().optional(),
  summarizedObject: z.string().optional(),
  summaryForeignKey: z.string().optional(),
  summarizedField: z.string().optional(),
});

const customObjectSchema = z.object({
  apiName: z.string().min(1),
  label: z.string().min(1),
  pluralLabel: z.string().min(1),
  description: z.string().optional(),
  deploymentStatus: z.string().optional(),
  sharingModel: z.string().optional(),
  enableActivities: z.boolean().optional(),
  enableReports: z.boolean().optional(),
  enableSearch: z.boolean().optional(),
  enableHistory: z.boolean().optional(),
  nameField: z.object({
    label: z.string().min(1),
    type: z.enum(["Text", "AutoNumber"]),
    displayFormat: z.string().optional(),
  }),
  fields: z.array(customFieldSchema).optional(),
});

const schemaFileSchema = z.object({
  objects: z.array(customObjectSchema).optional(),
  fields: z
    .array(
      customFieldSchema.extend({
        objectApiName: z.string().min(1),
      }),
    )
    .optional(),
  picklistUpdates: z
    .array(
      z.object({
        objectApiName: z.string().min(1),
        fieldApiName: z.string().min(1),
        values: z.array(picklistValueSchema),
      }),
    )
    .optional(),
});

export async function loadSchemaFile(schemaPath: string): Promise<SchemaFile> {
  const raw = await readFile(schemaPath, "utf8");
  const ext = path.extname(schemaPath).toLowerCase();
  const parsed = ext === ".yaml" || ext === ".yml" ? yaml.load(raw) : JSON.parse(raw);
  return schemaFileSchema.parse(parsed) as SchemaFile;
}
