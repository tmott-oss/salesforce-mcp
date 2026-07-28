# Sales Navigator Outreach Workflow

This workflow replaces the old copy-profile-to-ChatGPT loop with a Salesforce-backed queue.

## Daily Flow

1. Save target leads in LinkedIn Sales Navigator.
2. Let Sales Navigator sync those leads and activity into Salesforce.
3. Open the Salesforce report: Daily Sales Nav Outreach Queue.
4. Run the Codex queue command:

```bash
cd "/Users/troymott/Documents/New project/salesforce-mcp"
npm run daily-outreach -- --limit=8
```

5. Review the recommended leads, persona classification, and draft messages.
6. Paste approved messages into Sales Navigator and send manually.
7. Let Sales Navigator sync completed LinkedIn activity back to Salesforce.
8. Use the Sales Outreach Activity reports/dashboard to track effort.

## Drafting Rules

The first LinkedIn message should start a conversation, not sell.

- Do not ask for a meeting.
- Do not pitch Halosight.
- Do not include links.
- Do not use a sales cadence tone.
- Do not say "I help companies" or "I'd love to show you."
- Keep messages roughly 75-140 words.
- Sound like one executive starting a thoughtful conversation with another.
- Low-confidence messages are not placed into the ready queue. Review the Sales Navigator profile first.

## Classification

The workflow classifies leads into:

- Tier 1 Buyer: sales, commercial, revenue, customer success, sales enablement, or commercial operations.
- Strategic Influencer: CIO, CTO, AI, digital transformation, or strategy roles.
- Executive Sponsor: CEO, president, COO, or equivalent senior operator.
- Low Priority: HR, procurement, legal, audit, ERP, or PMO unless there is a strong strategic reason.

## Personalization Confidence

The queue separates messages into two groups:

- Ready for review: High- or Medium-confidence drafts based on a clear role, scope, or persona signal.
- Manual profile review required: Low-confidence records where Salesforce only has general title/company context.

If the Lead field `Manual_Profile_Review_Required__c` is added later, run the queue with `--mark-review` to write Low-confidence records back to Salesforce.

## Current Limitation

Salesforce currently provides strong structured fields such as name, title, company, owner, status, and LinkedIn activity history. It does not reliably store the full Sales Navigator profile text, recent posts, or profile narrative.

For richer personalization, paste the Sales Navigator profile text into Codex and ask for a one-off executive outreach draft.
