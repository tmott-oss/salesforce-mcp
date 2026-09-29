# Admin Maintenance Scripts

These scripts are optional. They are intended for Salesforce admins or approved operators, not normal teammate setup.

## Account Context To Opportunity Related Lists

Use this when Account-level emails, notes, or meeting-summary notes should also appear on the related Opportunity.

Dry run first:

```bash
npm run sync-account-context -- --since=2025-01-01
```

Limit to one Opportunity before any production batch:

```bash
npm run sync-account-context -- --opportunity-id=006XXXXXXXXXXXXXXX --since=2025-01-01
```

Execute only after reviewing the dry run:

```bash
SF_ALLOW_WRITE=1 npm run sync-account-context -- --opportunity-id=006XXXXXXXXXXXXXXX --since=2025-01-01 --execute
```

What it creates:

- Account `EmailMessage` records are cloned to the Opportunity `Emails` related list.
- Account classic `Note` records are cloned to the Opportunity `Notes` related list.
- Account Enhanced Notes are linked to the Opportunity `Notes` related list.
- Account meeting-summary-style Tasks or Events are copied into Opportunity `Notes`.

Safety behavior:

- Default mode is dry run.
- `--execute` requires `SF_ALLOW_WRITE=1`.
- Synced records include a source marker so repeated runs can skip duplicates.
- Matching existing Opportunity records are skipped when detected.

Do not run this as part of ordinary coworker setup.
