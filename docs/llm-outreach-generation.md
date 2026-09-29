# LLM Outreach Generation Dry Run

This design keeps the current template generator as the default production path. The LLM workflow only runs when explicitly requested:

```bash
npm run daily-outreach -- --limit=5 --draft-mode=llm-dry-run
```

Do not enable `OUTREACH_DRAFT_MODE=llm` for the daily Slack workflow until dry-run output is approved.

## Architecture

1. Preserve the existing Salesforce Lead query, scoring, classification, prior-activity suppression, queue limits, and Slack review flow.
2. Generate the existing deterministic template draft first.
3. If `draft-mode=template`, use the current template draft unchanged.
4. If `draft-mode=llm-dry-run` or `draft-mode=llm`, build an LLM context packet from:
   - Lead name, title, company, geography, Salesforce fields, LinkedIn URLs, and description.
   - Prior LinkedIn-related Tasks, including subject, date, status, type, and description.
   - Salesforce Notes and Enhanced Notes when the org exposes them through the API.
   - Other recipients from the same company in the current queue.
   - Other recipients from the same company in recent local generation logs.
   - The deterministic persona, angle, and template draft as rejectable defaults.
5. Ask the model to decide whether to draft, change strategy, or require manual profile research.
6. Constrain both model calls with Responses API structured-output JSON schemas.
7. Run a second critique pass.
8. Use the approved or revised LLM draft, or mark the record for manual research.
9. If the API is unavailable and fallback is enabled, use the deterministic draft with the label `Template fallback — manual rewrite required`.
10. Log the supplied context, selected strategy, first-pass draft, critique result, final draft, model, and fallback status. Never log API keys.

## Files And Functions

- `scripts/daily-outreach-queue.cjs`
  - Adds `draftMode` configuration.
  - Expands Salesforce context fields and Task descriptions.
  - Adds note retrieval and recent-generation-log context.
  - Calls the LLM generator only in explicit LLM modes.
  - Prints side-by-side output in `llm-dry-run` mode.
- `scripts/outreach-llm.cjs`
  - Owns the OpenAI runtime call, prompts, critique pass, fallback handling, and audit logging.
- `.env.example`
  - Documents LLM configuration.
- `package.json` / `package-lock.json`
  - Adds the official OpenAI Node SDK.

## Generation Prompt

System:

```text
You generate first-touch LinkedIn Sales Navigator outreach drafts for Troy Mott.

Sender:
- Troy Mott
- VP of AI Operations at Halosight

Message philosophy:
- Begin with a genuine observation, belief, lesson, or professional curiosity.
- Explain why the subject is relevant to Troy.
- Naturally identify Troy as VP of AI Operations at Halosight unless there is a strong person-specific reason not to.
- Explain why the recipient's role made the connection relevant.
- Write as one executive connecting with another, not as a seller prospecting a buyer.
- Do not diagnose the recipient's organization.
- Do not describe Halosight's product, platform, service, or solution.
- Do not ask for a meeting.
- Do not end with a diagnostic discovery question.
- Avoid sales cadence language, pitch language, and generic networking fluff.
- Keep the message concise enough for LinkedIn.

Authority:
- You may reject the default persona or default angle if the recipient context points elsewhere.
- You may choose a different conversation strategy.
- You may decide there is insufficient personalization and recommend manual profile research instead of drafting.
- If the available context is only name, title, and company, be conservative; do not invent facts.

Return only valid JSON matching the requested schema.
```

User:

```text
Generate a LinkedIn Sales Navigator first-touch draft using the context below.

Recipient context:
{recipient JSON}

Salesforce and activity context:
{salesforce JSON}

Queue coordination context:
{queue coordination JSON}

Default deterministic recommendation, which you may reject:
{default recommendation JSON}

Required JSON fields:
- shouldDraft: boolean
- manualReviewReason: string
- selectedPersona: string
- selectedConversationStrategy: string
- selectedAngle: string
- angleDecision: keep_default | modify_default | reject_default
- roleRelevance: string
- draft: string
- rationale: string

If shouldDraft is false, leave draft empty and explain what profile research is needed.
```

## Critique Prompt

System:

```text
You are a strict reviewer for executive LinkedIn Sales Navigator outreach.
Reject weak, generic, salesy, or template-like drafts.
Return only valid JSON matching the requested schema.
```

User:

```text
Critique this draft against the rules below.

Reject if it:
- sounds like prospecting;
- states or implies that the recipient has a problem;
- uses product or solution language;
- ends with a diagnostic question;
- could be sent to many people with only the name and company changed;
- substantially duplicates another message in the queue;
- omits "VP of AI Operations at Halosight" without a strong person-specific reason.

Recipient and queue context:
{context JSON}

First-pass generation:
{generation JSON}

Required JSON fields:
- approved: boolean
- reasons: string[]
- revisedDraft: string
- finalConversationStrategy: string
- finalAngle: string
- manualReviewRequired: boolean
- manualReviewReason: string

If rejected but fixable, provide a revisedDraft. If not fixable without more research, set manualReviewRequired true and leave revisedDraft empty.
```

## Structured Output Schemas

Generation schema fields:

- `shouldDraft`
- `manualReviewReason`
- `selectedPersona`
- `selectedConversationStrategy`
- `selectedAngle`
- `angleDecision`
- `roleRelevance`
- `draft`
- `rationale`

Critique schema fields:

- `approved`
- `reasons`
- `revisedDraft`
- `finalConversationStrategy`
- `finalAngle`
- `manualReviewRequired`
- `manualReviewReason`

## Configuration

```bash
OPENAI_API_KEY=YOUR_OPENAI_API_KEY
OUTREACH_DRAFT_MODE=template
OUTREACH_LLM_MODEL=gpt-5-mini
OUTREACH_LLM_REASONING_EFFORT=low
OUTREACH_LLM_MAX_OUTPUT_TOKENS=900
OUTREACH_LLM_TIMEOUT_MS=30000
OUTREACH_LLM_FALLBACK=template
OUTREACH_LLM_LOG_PATH=.outreach-generation-log.jsonl
```

## Estimated Cost

Default estimate uses `gpt-5-mini`, two model calls per recipient, and roughly 28,500 input tokens plus 3,000 output tokens for five recipients.

At $0.25 per 1M input tokens and $2.00 per 1M output tokens, a five-message batch is roughly $0.01-$0.02 before prompt caching. Use `gpt-5` only if quality requires it; the same batch would usually still be well under $0.10.
