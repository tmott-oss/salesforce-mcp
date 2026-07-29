# Welcome Mat: Salesforce MCP + Sales Navigator Outreach

This repo gives each teammate a local MCP server that connects directly to Salesforce, plus an optional Sales Navigator outreach queue.

## What This Does

- Connects a local MCP client to Salesforce through REST, Tooling, and Metadata APIs.
- Lets approved users query and update Salesforce records.
- Supports schema work such as custom objects and fields when metadata writes are enabled.
- Generates a daily Sales Navigator outreach queue from Salesforce Leads.
- Holds low-confidence outreach for manual profile review so messages do not become generic.

## Setup In 10 Minutes

1. Clone the repo.

```bash
git clone https://github.com/tmott-oss/salesforce-mcp.git
cd salesforce-mcp
```

2. Install dependencies.

```bash
npm install
```

3. Create your local env file.

```bash
cp .env.example .env
```

4. Edit `.env` with your Salesforce client ID and sender context.

```env
SF_LOGIN_URL=https://login.salesforce.com
SF_CLIENT_ID=YOUR_SALESFORCE_CONSUMER_KEY
SF_AUTH_MODE=pkce
SF_REDIRECT_PORT=8788

OUTREACH_SENDER_NAME=Your Name
OUTREACH_SENDER_TITLE=Your Title
OUTREACH_SENDER_COMPANY=Your Company
OUTREACH_SENDER_FUNCTIONAL_ROLE=leading your function
OUTREACH_SENDER_WORK_CONTEXT=the work you lead around your customer problem
```

5. Build the project.

```bash
npm run build
```

6. Log in to Salesforce.

```bash
npm run dev:login
```

7. Run a quick Salesforce test.

```bash
npm run dev:serve
```

Then connect it from Codex, Claude Code, or another MCP client using the config in the main `README.md`.

## Salesforce Prerequisites

Ask your Salesforce admin to confirm:

- Your user has `API Enabled`.
- Your user has the Salesforce permissions needed for your work.
- For schema changes, your user has `Customize Application`.
- For schema changes, your user has `Modify Metadata Through Metadata API Functions`.
- The External Client App callback URL includes `http://localhost:8788/oauth/callback`.
- The External Client App includes scopes `api refresh_token web`.

Do not enable write or metadata flags unless you are approved to make those changes.

## Local Safety Rules

- Never commit `.env`.
- Never commit `.sf-auth.json`.
- Keep `SF_ALLOW_WRITE` off unless you intentionally need record writes.
- Keep `SF_ALLOW_METADATA` off unless you intentionally need schema changes.
- Use dry runs for schema changes first.

## Customizing Outreach For Your Voice

The outreach generator uses your `.env` sender context to place credibility later in the message. It should start with the recipient's business problem, then explain why you have a useful perspective.

Fill these in:

```env
OUTREACH_SENDER_NAME=
OUTREACH_SENDER_TITLE=
OUTREACH_SENDER_COMPANY=
OUTREACH_SENDER_FUNCTIONAL_ROLE=
OUTREACH_SENDER_WORK_CONTEXT=
```

Examples:

```env
OUTREACH_SENDER_NAME=Jane Smith
OUTREACH_SENDER_TITLE=Director of Revenue Operations
OUTREACH_SENDER_COMPANY=Acme
OUTREACH_SENDER_FUNCTIONAL_ROLE=leading revenue operations
OUTREACH_SENDER_WORK_CONTEXT=forecast quality, rep workflow, and customer handoffs
```

```env
OUTREACH_SENDER_NAME=Alex Johnson
OUTREACH_SENDER_TITLE=VP of Customer Success
OUTREACH_SENDER_COMPANY=Acme
OUTREACH_SENDER_FUNCTIONAL_ROLE=leading customer success
OUTREACH_SENDER_WORK_CONTEXT=retention risk, customer commitments, and account intelligence
```

## Running The Outreach Queue

Use this only after Sales Navigator has synced saved leads into Salesforce.

```bash
npm run daily-outreach -- --limit=8
```

For a fresh next batch:

```bash
npm run daily-outreach -- --limit=8 --offset=8
```

To avoid seeing the same batch again:

```bash
npm run daily-outreach -- --limit=8 --remember
```

The output has two groups:

- `Ready for review`: High- or Medium-confidence drafts.
- `Manual Profile Review Required`: Low-confidence leads that need a human to review Sales Navigator first.

## Message Quality Rules

- Start with the recipient's role-relevant business problem.
- Keep the tone executive-to-executive.
- Do not pitch, ask for a meeting, or include links in the first message.
- Add sender credibility later as context, not status.
- Do not send Low-confidence drafts without reviewing the LinkedIn profile.
- Treat the generated message as a draft. Human review still matters.

## First-Day Checklist

- Repo cloned.
- `npm install` complete.
- `.env` created and customized.
- Salesforce login completed.
- MCP client can run `soql_query("SELECT Id, Name FROM Account LIMIT 3")`.
- Outreach queue runs with your sender context.
- You understand whether write/metadata permissions are enabled.

