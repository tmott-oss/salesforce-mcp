# Sales Navigator Outreach Workflow

This workflow replaces the old copy-profile-to-ChatGPT loop with a Salesforce-backed queue.

## Daily Flow

1. Save target leads in LinkedIn Sales Navigator.
2. Let Sales Navigator sync those leads and activity into Salesforce.
3. Open the Salesforce report: Daily Sales Nav Outreach Queue.
4. Run the Codex queue command:

```bash
cd "/Users/troymott/Documents/New project/salesforce-mcp"
npm run daily-outreach -- --limit=5
```

5. Review the recommended leads, persona classification, and draft messages.
6. Paste approved messages into Sales Navigator and send manually.
7. Let Sales Navigator sync completed LinkedIn activity back to Salesforce.
8. Use the Sales Outreach Activity reports/dashboard to track effort.

## Drafting Rules

The first LinkedIn message should target director-and-above sales leaders with a bold value proposition matched to the lead's likely operating scope.

- Ask whether the recipient is open to 20 minutes next week.
- Determine operating scope before drafting: field sales leadership, regional/local sales, national or strategic accounts, new business development, channel or partnerships, sales operations, specialized business unit, or unknown.
- If operating scope is unknown, require manual profile review before generating a meeting-oriented message.
- Clearly name Halosight and match the message to the recipient's scope.
- Prefer complete account context, stronger account memory, customer conversation context, and automatic follow-through.
- Prefer phrases like "Halosight enables," "Halosight captures," and "That's what Halosight does."
- Never use "perfect account memory" or "Halosight is building."
- Do not include links.
- Do not use a generic sales cadence tone.
- Do not say "I help companies" or "I'd love to show you."
- Keep messages concise enough for LinkedIn.
- Sound like a direct executive note to a sales leader.
- Low-confidence messages are not placed into the ready queue. Review the Sales Navigator profile first.
- Do not diagnose the recipient's organization beyond saying what the capability could mean for their company.

## Classification

The queue now only drafts for director-and-above sales leaders. It weeds out records that do not have both a seniority signal and a sales-leadership signal.

- Seniority signal: director, VP, vice president, president, chief, head, or general manager.
- Sales-leadership signal: sales, revenue, commercial, business development, GTM, field, account, sales enablement, sales operations, or commercial operations.
- Non-sales senior leaders, operations-only leaders, and below-director sales roles are excluded from the ready queue.

## Personalization Confidence

The queue separates messages into two groups:

- Ready for review: High- or Medium-confidence drafts based on a clear role, scope, or persona signal.
- Manual profile review required: Low-confidence records where Salesforce only has general title/company context.

If the Lead field `Manual_Profile_Review_Required__c` is added later, run the queue with `--mark-review` to write Low-confidence records back to Salesforce.

## Current Limitation

Salesforce currently provides strong structured fields such as name, title, company, owner, status, and LinkedIn activity history. It does not reliably store the full Sales Navigator profile text, recent posts, or profile narrative.

For richer personalization, paste the Sales Navigator profile text into Codex and ask for a one-off executive outreach draft.
