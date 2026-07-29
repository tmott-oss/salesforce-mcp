# Salesforce MCP Server

Local stdio MCP server for Salesforce using direct API access via `jsforce` and the official MCP TypeScript SDK.

New teammates should start here: [Welcome Mat](docs/welcome-mat.md).

It supports:

- Salesforce OAuth Authorization Code + PKCE or JWT bearer auth
- REST API record access and mutation
- Tooling-enabled `jsforce` connection
- Metadata API creation and updates for `CustomObject` and `CustomField`
- Declarative schema application from JSON or YAML

## Requirements

- Node.js 20+
- A Salesforce user with:
  - `API Enabled`
  - `Customize Application`
  - `Modify Metadata Through Metadata API Functions`
- An External Client App or Connected App client ID

## Install

```bash
npm install
```

## Environment

Copy `.env.example` to `.env` and set at minimum:

```env
SF_LOGIN_URL=https://login.salesforce.com
SF_CLIENT_ID=YOUR_CLIENT_ID
SF_AUTH_MODE=pkce
SF_REDIRECT_PORT=8788
```

Optional flags:

```env
SF_ALLOW_WRITE=1
SF_ALLOW_METADATA=1
SF_TOKEN_PATH=/absolute/path/to/.sf-auth.json
```

JWT mode:

```env
SF_AUTH_MODE=jwt
SF_USERNAME=admin@example.com
SF_JWT_PRIVATE_KEY_PATH=/absolute/path/to/server.key
```

## Login

### PKCE

Run:

```bash
npm run dev:login
```

On first run the CLI prints the exact redirect URI you must add to the External Client App callback list:

```text
http://localhost:8788/oauth/callback
```

Scopes to allow on the Salesforce app:

```text
api refresh_token web
```

If your org requires My Domain login, set `SF_LOGIN_URL` to that domain before running login.

### JWT

Configure:

```env
SF_AUTH_MODE=jwt
SF_USERNAME=admin@example.com
SF_JWT_PRIVATE_KEY_PATH=/absolute/path/to/server.key
```

Then run:

```bash
npm run dev:login
```

## Usage

### Start the stdio MCP server

```bash
npm run dev:serve
```

### Apply a schema file from the CLI

```bash
npm run dev:apply-schema -- examples/custom-crm.schema.yaml --dry-run
npm run dev:apply-schema -- examples/custom-crm.schema.yaml
```

## Exposed MCP Tools

### Data

- `soql_query(query)`
- `describe_sobject(name)`
- `create_record(sobject, fields)`
- `update_record(sobject, id, fields)`
- `upsert_record(sobject, extIdField, rec)`
- `delete_record(sobject, id, dryRun?)`

### Schema

- `create_custom_object(spec, dryRun?)`
- `create_custom_field(objectApiName, spec, dryRun?)`
- `add_picklist_values(objectApiName, fieldApiName, values, dryRun?)`
- `apply_schema(schemaFile, dryRun?)`

## Safety

- `delete_record` requires `SF_ALLOW_WRITE=1` unless `dryRun: true`
- Metadata mutations require `SF_ALLOW_METADATA=1` unless `dryRun: true`
- Tokens are persisted to a `0600` JSON file
- No secrets are hardcoded; everything comes from env

## Example Acceptance Flow

After login:

```text
soql_query("SELECT Id, Name FROM Account LIMIT 3")
create_custom_field("Account", { apiName: "Lifecycle_Stage", label: "Lifecycle Stage", type: "Picklist", valueSet: { values: [{ fullName: "Prospect" }, { fullName: "Customer" }] } })
describe_sobject("Account")
create_record("Account", { Name: "MCP Test Account" })
soql_query("SELECT Id, Name FROM Account WHERE Name = 'MCP Test Account'")
```

For idempotent schema deployment:

```bash
npm run dev:apply-schema -- examples/custom-crm.schema.yaml
```

Re-running that command is safe because the server upserts objects and creates-or-updates fields.

## MCP Client Config

### Codex

```json
{
  "mcpServers": {
    "salesforce": {
      "command": "node",
      "args": [
        "/absolute/path/to/salesforce-mcp/dist/index.js",
        "serve"
      ],
      "env": {
        "SF_LOGIN_URL": "https://login.salesforce.com",
        "SF_CLIENT_ID": "YOUR_CLIENT_ID",
        "SF_AUTH_MODE": "pkce",
        "SF_REDIRECT_PORT": "8788",
        "SF_TOKEN_PATH": "/absolute/path/to/salesforce-mcp/.sf-auth.json",
        "SF_ALLOW_WRITE": "1",
        "SF_ALLOW_METADATA": "1"
      }
    }
  }
}
```

### Claude Code

```json
{
  "mcpServers": {
    "salesforce": {
      "command": "node",
      "args": [
        "/absolute/path/to/salesforce-mcp/dist/index.js",
        "serve"
      ],
      "env": {
        "SF_LOGIN_URL": "https://login.salesforce.com",
        "SF_CLIENT_ID": "YOUR_CLIENT_ID",
        "SF_AUTH_MODE": "pkce",
        "SF_REDIRECT_PORT": "8788",
        "SF_TOKEN_PATH": "/absolute/path/to/salesforce-mcp/.sf-auth.json",
        "SF_ALLOW_WRITE": "1",
        "SF_ALLOW_METADATA": "1"
      }
    }
  }
}
```

## Build

```bash
npm run build
```
