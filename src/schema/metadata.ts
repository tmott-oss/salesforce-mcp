import type { Connection } from "jsforce";
import type { SaveResult, UpsertResult } from "jsforce/lib/api/metadata/schema.js";
import type { AppConfig } from "../lib/config.js";
import type {
  CustomFieldSpec,
  CustomObjectSpec,
  PicklistValueSpec,
  SchemaFile,
} from "../types/schema.js";
import { loadSchemaFile } from "./io.js";

export interface SchemaPlanStep {
  action: string;
  target: string;
  payload: unknown;
}

export interface ApplySchemaResult {
  dryRun: boolean;
  plan: SchemaPlanStep[];
  results: Array<{
    action: string;
    target: string;
    result?: SaveResult | UpsertResult | SaveResult[] | UpsertResult[];
    skipped?: boolean;
    reason?: string;
  }>;
}

export function ensureMetadataAllowed(config: AppConfig, dryRun = false): void {
  if (!config.allowMetadata && !dryRun) {
    throw new Error("Metadata operations are disabled. Set SF_ALLOW_METADATA=1 or use dryRun.");
  }
}

export function buildCustomObjectMetadata(spec: CustomObjectSpec) {
  return stripUndefined({
    fullName: normalizeObjectApiName(spec.apiName),
    label: spec.label,
    pluralLabel: spec.pluralLabel,
    deploymentStatus: spec.deploymentStatus ?? "Deployed",
    sharingModel: spec.sharingModel ?? "ReadWrite",
    enableActivities: spec.enableActivities ?? true,
    enableReports: spec.enableReports ?? true,
    enableSearch: spec.enableSearch ?? true,
    enableHistory: spec.enableHistory ?? false,
    description: spec.description,
    nameField: {
      type: spec.nameField.type,
      label: spec.nameField.label,
      displayFormat:
        spec.nameField.type === "AutoNumber"
          ? spec.nameField.displayFormat ?? "OBJ-{0000}"
          : undefined,
    },
  });
}

export function buildCustomFieldMetadata(objectApiName: string, spec: CustomFieldSpec) {
  const fullName = `${normalizeObjectApiName(objectApiName)}.${normalizeFieldApiName(spec.apiName)}`;
  const base = {
    fullName,
    label: spec.label,
    type: mapFieldType(spec.type),
    description: spec.description,
    required: spec.required,
    unique: spec.unique,
    externalId: spec.externalId,
    defaultValue: spec.defaultValue,
    inlineHelpText: spec.inlineHelpText,
  } as Record<string, unknown>;

  switch (spec.type) {
    case "Text":
      base.length = spec.length ?? 255;
      break;
    case "LongTextArea":
      base.length = spec.length ?? 32768;
      base.visibleLines = spec.visibleLines ?? 3;
      break;
    case "Number":
      base.precision = spec.precision ?? 18;
      base.scale = spec.scale ?? 0;
      break;
    case "Date":
    case "Checkbox":
    case "Url":
      break;
    case "Picklist":
    case "MultiselectPicklist":
      base.valueSet = buildValueSet(spec.valueSet?.values ?? [], spec.valueSet?.restricted, spec.valueSet?.sorted);
      if (spec.type === "MultiselectPicklist") {
        base.visibleLines = spec.visibleLines ?? 4;
      }
      break;
    case "Formula":
      base.formula = spec.formula;
      base.formulaTreatBlanksAs = spec.formulaTreatBlanksAs ?? "BlankAsBlank";
      inferFormulaReturnType(base, spec);
      break;
    case "Lookup":
      base.referenceTo = spec.referenceTo;
      base.relationshipLabel = spec.relationshipLabel ?? spec.label;
      base.relationshipName = spec.relationshipName ?? toRelationshipName(spec.apiName);
      base.deleteConstraint = spec.deleteConstraint ?? "SetNull";
      break;
    case "MasterDetail":
      base.referenceTo = spec.referenceTo;
      base.relationshipLabel = spec.relationshipLabel ?? spec.label;
      base.relationshipName = spec.relationshipName ?? toRelationshipName(spec.apiName);
      base.reparentableMasterDetail = spec.reparentableMasterDetail ?? false;
      base.writeRequiresMasterRead = spec.writeRequiresMasterRead ?? false;
      break;
    case "RollupSummary":
      base.summaryOperation = spec.summaryOperation;
      base.summaryForeignKey = spec.summaryForeignKey;
      base.summarizedField = spec.summarizedField;
      break;
    default:
      throw new Error(`Unsupported field type: ${spec.type satisfies never}`);
  }

  return stripUndefined(base);
}

export async function createOrUpdateCustomObject(
  conn: Connection,
  config: AppConfig,
  spec: CustomObjectSpec,
  dryRun = false,
): Promise<{ payload: unknown; result?: UpsertResult }> {
  ensureMetadataAllowed(config, dryRun);
  const payload = buildCustomObjectMetadata(spec);
  if (dryRun) {
    return { payload };
  }

  const result = (await conn.metadata.upsert("CustomObject", payload)) as UpsertResult;
  return { payload, result };
}

export async function createOrUpdateCustomField(
  conn: Connection,
  config: AppConfig,
  objectApiName: string,
  spec: CustomFieldSpec,
  dryRun = false,
): Promise<{ payload: unknown; result?: UpsertResult | SaveResult }> {
  ensureMetadataAllowed(config, dryRun);
  const payload = buildCustomFieldMetadata(objectApiName, spec);
  if (dryRun) {
    return { payload };
  }

  const fieldFullName = `${normalizeObjectApiName(objectApiName)}.${normalizeFieldApiName(spec.apiName)}`;
  const existing = await tryReadCustomField(conn, fieldFullName);
  if (existing) {
    const result = (await conn.metadata.update("CustomField", payload)) as SaveResult;
    return { payload, result };
  }

  const result = (await conn.metadata.create("CustomField", payload)) as SaveResult;
  return { payload, result };
}

export async function addPicklistValues(
  conn: Connection,
  config: AppConfig,
  objectApiName: string,
  fieldApiName: string,
  values: PicklistValueSpec[],
  dryRun = false,
): Promise<{ payload: unknown; result?: SaveResult; mergedValues?: PicklistValueSpec[] }> {
  ensureMetadataAllowed(config, dryRun);
  const fullName = `${normalizeObjectApiName(objectApiName)}.${normalizeFieldApiName(fieldApiName)}`;
  const existing = await tryReadCustomField(conn, fullName);
  if (!existing) {
    throw new Error(`CustomField ${fullName} does not exist or could not be read via Metadata API.`);
  }

  const currentValues = extractCurrentPicklistValues(existing);
  const merged = mergePicklistValues(currentValues, values);
  const payload = {
    fullName,
    valueSet: buildValueSet(merged),
  };

  if (dryRun) {
    return { payload, mergedValues: merged };
  }

  const result = (await conn.metadata.update("CustomField", payload)) as SaveResult;
  return { payload, result, mergedValues: merged };
}

export async function applySchemaFile(
  conn: Connection,
  config: AppConfig,
  schemaPath: string,
  dryRun = false,
): Promise<ApplySchemaResult> {
  const schema = await loadSchemaFile(schemaPath);
  return applySchema(conn, config, schema, dryRun);
}

export async function applySchema(
  conn: Connection,
  config: AppConfig,
  schema: SchemaFile,
  dryRun = false,
): Promise<ApplySchemaResult> {
  ensureMetadataAllowed(config, dryRun);
  const plan: SchemaPlanStep[] = [];
  const results: ApplySchemaResult["results"] = [];
  const stagedFields: Array<{ objectApiName: string; fieldSpec: CustomFieldSpec }> = [];

  for (const objectSpec of schema.objects ?? []) {
    const objectPayload = buildCustomObjectMetadata(objectSpec);
    plan.push({
      action: "upsert_custom_object",
      target: normalizeObjectApiName(objectSpec.apiName),
      payload: objectPayload,
    });

    const objectResult = dryRun
      ? undefined
      : ((await conn.metadata.upsert("CustomObject", objectPayload)) as UpsertResult);

    results.push({
      action: "upsert_custom_object",
      target: normalizeObjectApiName(objectSpec.apiName),
      result: objectResult,
    });

    for (const fieldSpec of objectSpec.fields ?? []) {
      stagedFields.push({
        objectApiName: objectSpec.apiName,
        fieldSpec,
      });
    }
  }

  for (const fieldSpec of schema.fields ?? []) {
    stagedFields.push({
      objectApiName: fieldSpec.objectApiName,
      fieldSpec,
    });
  }

  const orderedFields = [
    ...stagedFields.filter(({ fieldSpec }) => fieldSpec.type !== "RollupSummary"),
    ...stagedFields.filter(({ fieldSpec }) => fieldSpec.type === "RollupSummary"),
  ];

  for (const { objectApiName, fieldSpec } of orderedFields) {
    const fieldPayload = buildCustomFieldMetadata(objectApiName, fieldSpec);
    const fullName = `${normalizeObjectApiName(objectApiName)}.${normalizeFieldApiName(fieldSpec.apiName)}`;

    plan.push({
      action: "upsert_custom_field",
      target: fullName,
      payload: fieldPayload,
    });

    if (dryRun) {
      results.push({ action: "upsert_custom_field", target: fullName });
      continue;
    }

    const existing = await tryReadCustomField(conn, fullName);
    const result = existing
      ? ((await conn.metadata.update("CustomField", fieldPayload)) as SaveResult)
      : ((await conn.metadata.create("CustomField", fieldPayload)) as SaveResult);

    results.push({
      action: "upsert_custom_field",
      target: fullName,
      result,
    });
  }

  for (const update of schema.picklistUpdates ?? []) {
    const addValuesPlan = await addPicklistValues(
      conn,
      config,
      update.objectApiName,
      update.fieldApiName,
      update.values,
      true,
    );

    plan.push({
      action: "update_picklist_values",
      target: `${normalizeObjectApiName(update.objectApiName)}.${normalizeFieldApiName(update.fieldApiName)}`,
      payload: addValuesPlan.payload,
    });

    if (dryRun) {
      results.push({
        action: "update_picklist_values",
        target: `${normalizeObjectApiName(update.objectApiName)}.${normalizeFieldApiName(update.fieldApiName)}`,
      });
      continue;
    }

    const executed = await addPicklistValues(
      conn,
      config,
      update.objectApiName,
      update.fieldApiName,
      update.values,
      false,
    );

    results.push({
      action: "update_picklist_values",
      target: `${normalizeObjectApiName(update.objectApiName)}.${normalizeFieldApiName(update.fieldApiName)}`,
      result: executed.result,
    });
  }

  return { dryRun, plan, results };
}

async function tryReadCustomField(conn: Connection, fullName: string): Promise<any | null> {
  try {
    const metadata = await conn.metadata.read("CustomField", fullName);
    if (!metadata || typeof metadata !== "object" || !("fullName" in metadata)) {
      return null;
    }
    return metadata;
  } catch {
    return null;
  }
}

function buildValueSet(values: PicklistValueSpec[], restricted = false, sorted = false) {
  return {
    restricted,
    valueSetDefinition: {
      sorted,
      value: values.map((value) => ({
        fullName: value.fullName,
        label: value.label ?? value.fullName,
        default: value.default ?? false,
        isActive: value.isActive ?? true,
        description: value.description,
      })),
    },
  };
}

function extractCurrentPicklistValues(metadata: any): PicklistValueSpec[] {
  const rawValues = metadata?.valueSet?.valueSetDefinition?.value ?? [];
  return rawValues.map((value: any) => ({
    fullName: value.fullName,
    label: value.label,
    default: value.default,
    isActive: value.isActive,
    description: value.description,
  }));
}

function mergePicklistValues(current: PicklistValueSpec[], incoming: PicklistValueSpec[]): PicklistValueSpec[] {
  const merged = new Map<string, PicklistValueSpec>();
  for (const value of current) {
    merged.set(value.fullName, value);
  }
  for (const value of incoming) {
    merged.set(value.fullName, {
      ...merged.get(value.fullName),
      ...value,
    });
  }
  return [...merged.values()];
}

function inferFormulaReturnType(base: Record<string, unknown>, spec: CustomFieldSpec): void {
  if (spec.formulaReturnType) {
    base.type = spec.formulaReturnType;
    if (spec.formulaReturnType === "Number" || spec.formulaReturnType === "Currency" || spec.formulaReturnType === "Percent") {
      base.precision = spec.precision ?? 18;
      base.scale = spec.scale ?? 2;
      return;
    }
    if (spec.formulaReturnType === "Text") {
      base.length = spec.length ?? 255;
    }
    return;
  }

  if (spec.precision !== undefined) {
    base.type = "Number";
    base.precision = spec.precision;
    base.scale = spec.scale ?? 0;
    return;
  }

  if (spec.length !== undefined) {
    base.type = "Text";
    base.length = spec.length;
    return;
  }

  // Default the formula return type to Text when not specified indirectly.
  base.type = "Text";
  base.length = 255;
}

function mapFieldType(type: CustomFieldSpec["type"]): string {
  switch (type) {
    case "LongTextArea":
      return "LongTextArea";
    case "MultiselectPicklist":
      return "MultiselectPicklist";
    case "MasterDetail":
      return "MasterDetail";
    case "RollupSummary":
      return "Summary";
    default:
      return type;
  }
}

function toRelationshipName(apiName: string): string {
  return normalizeFieldApiName(apiName).replace(/__c$/, "");
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item)) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, stripUndefined(entryValue)]),
    ) as T;
  }

  return value;
}

export function normalizeObjectApiName(apiName: string): string {
  return apiName.endsWith("__c") || STANDARD_OBJECTS.has(apiName) ? apiName : `${apiName}__c`;
}

export function normalizeFieldApiName(apiName: string): string {
  return apiName.endsWith("__c") || STANDARD_FIELDS.has(apiName) ? apiName : `${apiName}__c`;
}

const STANDARD_OBJECTS = new Set([
  "Account",
  "Campaign",
  "Case",
  "Contact",
  "Contract",
  "Event",
  "Lead",
  "Opportunity",
  "Task",
  "User",
]);

const STANDARD_FIELDS = new Set([
  "AccountId",
  "Amount",
  "CampaignId",
  "CloseDate",
  "Company",
  "ContactId",
  "Description",
  "Email",
  "EndDate",
  "FirstName",
  "Id",
  "Industry",
  "LastName",
  "LeadSource",
  "Name",
  "OwnerId",
  "Phone",
  "StageName",
  "StartDate",
  "Status",
  "Subject",
  "Title",
  "Type",
  "Website",
]);
