export type FieldType =
  | "Text"
  | "LongTextArea"
  | "Number"
  | "Date"
  | "DateTime"
  | "Checkbox"
  | "Url"
  | "Picklist"
  | "MultiselectPicklist"
  | "Formula"
  | "Lookup"
  | "MasterDetail"
  | "RollupSummary";

export interface PicklistValueSpec {
  fullName: string;
  label?: string;
  default?: boolean;
  isActive?: boolean;
  description?: string;
}

export interface NameFieldSpec {
  label: string;
  type: "Text" | "AutoNumber";
  displayFormat?: string;
}

export interface CustomObjectSpec {
  apiName: string;
  label: string;
  pluralLabel: string;
  description?: string;
  deploymentStatus?: "Deployed" | "InDevelopment";
  sharingModel?:
    | "ReadWrite"
    | "ReadOnly"
    | "Private"
    | "ControlledByParent"
    | "FullAccess";
  enableActivities?: boolean;
  enableReports?: boolean;
  enableSearch?: boolean;
  enableHistory?: boolean;
  nameField: NameFieldSpec;
}

export interface CustomFieldSpec {
  apiName: string;
  label: string;
  type: FieldType;
  description?: string;
  required?: boolean;
  unique?: boolean;
  externalId?: boolean;
  defaultValue?: string;
  inlineHelpText?: string;
  relationshipLabel?: string;
  relationshipName?: string;
  reparentableMasterDetail?: boolean;
  writeRequiresMasterRead?: boolean;
  referenceTo?: string;
  deleteConstraint?: "Clear" | "Restrict" | "SetNull";
  length?: number;
  visibleLines?: number;
  precision?: number;
  scale?: number;
  formula?: string;
  formulaReturnType?: "Text" | "Number" | "Checkbox" | "Date" | "DateTime" | "Currency" | "Percent";
  formulaTreatBlanksAs?: "BlankAsBlank" | "BlankAsZero";
  valueSet?: {
    restricted?: boolean;
    sorted?: boolean;
    values: PicklistValueSpec[];
  };
  summaryOperation?: "Count" | "Sum" | "Min" | "Max" | "Avg";
  summarizedObject?: string;
  summaryForeignKey?: string;
  summarizedField?: string;
}

export interface ObjectSchemaSpec extends CustomObjectSpec {
  fields?: CustomFieldSpec[];
}

export interface SchemaFile {
  objects?: ObjectSchemaSpec[];
  fields?: Array<CustomFieldSpec & { objectApiName: string }>;
  picklistUpdates?: Array<{
    objectApiName: string;
    fieldApiName: string;
    values: PicklistValueSpec[];
  }>;
}
