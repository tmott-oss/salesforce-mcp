const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const defaultModel = "gpt-5-mini";
const defaultLogPath = path.join(process.cwd(), ".outreach-generation-log.jsonl");

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function llmConfigFromEnv() {
  return {
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OUTREACH_LLM_MODEL || defaultModel,
    reasoningEffort: process.env.OUTREACH_LLM_REASONING_EFFORT || "low",
    maxOutputTokens: asNumber(process.env.OUTREACH_LLM_MAX_OUTPUT_TOKENS, 900),
    timeoutMs: asNumber(process.env.OUTREACH_LLM_TIMEOUT_MS, 30000),
    fallbackBehavior: process.env.OUTREACH_LLM_FALLBACK || "template",
    logPath: process.env.OUTREACH_LLM_LOG_PATH || defaultLogPath,
  };
}

function outreachSystemPrompt() {
  return [
    "You generate first-touch LinkedIn Sales Navigator outreach drafts for Troy Mott.",
    "",
    "Sender:",
    "- Troy Mott",
    "- VP of AI Operations at Halosight",
    "",
    "Message philosophy:",
    "- The audience is director-and-above sales leaders only.",
    "- Do not use a field-sales message solely because the title includes Sales, Business Development, Vice President, or Director.",
    "- Before drafting, determine the recipient's likely operating scope: Field sales leadership, Regional/local sales, National or strategic accounts, New business development, Channel or partnerships, Sales operations, Specialized business unit, or Unknown.",
    "- Match the value proposition to that operating scope.",
    "- If operating scope is Unknown, set shouldDraft false and require manual profile research before generating a meeting-oriented message.",
    "- Use a bold, direct value proposition matched to the scope.",
    "- Prefer language such as complete account context, stronger account memory, Halosight enables, Halosight captures, or That's what Halosight does.",
    "- Never use these phrases: perfect account memory; Halosight is building.",
    "- Ask whether the recipient is open to 20 minutes next week.",
    "- Do not include a scheduling link.",
    "- Use Troy Mott as the sender; never use placeholders such as [Your Name].",
    "- Personalize only when the supplied context is specific and safe.",
    "- Do not over-explain, apologize, or sound like a generic networking note.",
    "- Do not diagnose the recipient's organization beyond saying what the capability could mean for their company.",
    "- Keep the message concise enough for LinkedIn.",
    "",
    "Authority:",
    "- You may reject the default persona or default angle if the recipient context points elsewhere.",
    "- You may choose a different conversation strategy.",
    "- You may decide there is insufficient sales-leadership fit or personalization and recommend manual profile research instead of drafting.",
    "- You must recommend manual profile research when operating scope is Unknown.",
    "- If the available context is only name, title, and company, be conservative; do not invent facts.",
    "",
    "Return only valid JSON matching the requested schema.",
  ].join("\n");
}

function outreachUserPrompt(context) {
  return [
    "Generate a LinkedIn Sales Navigator first-touch draft using the context below.",
    "",
    "Sender and scheduling context:",
    JSON.stringify(context.sender, null, 2),
    "",
    "Recipient context:",
    JSON.stringify(context.recipient, null, 2),
    "",
    "Salesforce and activity context:",
    JSON.stringify(context.salesforce, null, 2),
    "",
    "Queue coordination context:",
    JSON.stringify(context.queueCoordination, null, 2),
    "",
    "Default deterministic recommendation, which you may reject:",
    JSON.stringify(context.defaultRecommendation, null, 2),
    "",
    "Required JSON fields:",
    "- shouldDraft: boolean",
    "- manualReviewReason: string",
    "- selectedPersona: string",
    "- selectedConversationStrategy: string",
    "- selectedAngle: string",
    "- angleDecision: keep_default | modify_default | reject_default",
    "- roleRelevance: string",
    "- draft: string",
    "- rationale: string",
    "",
    "If shouldDraft is false, leave draft empty and explain what profile research is needed.",
  ].join("\n");
}

function critiqueSystemPrompt() {
  return [
    "You are a strict reviewer for executive LinkedIn Sales Navigator outreach.",
    "Reject weak, generic, salesy, or template-like drafts.",
    "Return only valid JSON matching the requested schema.",
  ].join("\n");
}

function critiqueUserPrompt(context, generation) {
  return [
    "Critique this draft against the rules below.",
    "",
    "Reject if it:",
    "- is not addressed to a director-and-above sales leader;",
    "- uses placeholders like [Your Name] or [Company];",
    "- sounds like generic networking instead of direct executive sales outreach;",
    "- uses a field-sales value proposition without evidence that the recipient's operating scope is field sales leadership;",
    "- fails to identify and use the likely operating scope;",
    "- drafts a meeting-oriented message when operating scope is Unknown;",
    "- uses the phrase perfect account memory;",
    "- uses the phrase Halosight is building;",
    "- avoids a bold value proposition matched to the operating scope;",
    "- omits complete account context, stronger account memory, customer conversation context, or follow-through;",
    "- omits Halosight;",
    "- omits a 20-minute next-week ask;",
    "- includes a scheduling link;",
    "- ends with a diagnostic discovery question instead of a clear meeting ask;",
    "- could be sent to many people with only the name and company changed;",
    "- substantially duplicates another message in the queue;",
    "- omits \"VP of AI Operations at Halosight\" without a strong person-specific reason.",
    "",
    "Recipient and queue context:",
    JSON.stringify(context, null, 2),
    "",
    "First-pass generation:",
    JSON.stringify(generation, null, 2),
    "",
    "Required JSON fields:",
    "- approved: boolean",
    "- reasons: string[]",
    "- revisedDraft: string",
    "- finalConversationStrategy: string",
    "- finalAngle: string",
    "- manualReviewRequired: boolean",
    "- manualReviewReason: string",
    "",
    "If rejected but fixable, provide a revisedDraft. If not fixable without more research, set manualReviewRequired true and leave revisedDraft empty.",
  ].join("\n");
}

const generationSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "shouldDraft",
    "manualReviewReason",
    "selectedPersona",
    "selectedConversationStrategy",
    "selectedAngle",
    "angleDecision",
    "roleRelevance",
    "draft",
    "rationale",
  ],
  properties: {
    shouldDraft: { type: "boolean" },
    manualReviewReason: { type: "string" },
    selectedPersona: { type: "string" },
    selectedConversationStrategy: { type: "string" },
    selectedAngle: { type: "string" },
    angleDecision: {
      type: "string",
      enum: ["keep_default", "modify_default", "reject_default"],
    },
    roleRelevance: { type: "string" },
    draft: { type: "string" },
    rationale: { type: "string" },
  },
};

const critiqueSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "approved",
    "reasons",
    "revisedDraft",
    "finalConversationStrategy",
    "finalAngle",
    "manualReviewRequired",
    "manualReviewReason",
  ],
  properties: {
    approved: { type: "boolean" },
    reasons: {
      type: "array",
      items: { type: "string" },
    },
    revisedDraft: { type: "string" },
    finalConversationStrategy: { type: "string" },
    finalAngle: { type: "string" },
    manualReviewRequired: { type: "boolean" },
    manualReviewReason: { type: "string" },
  },
};

function parseJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("Model returned an empty response.");
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Model returned non-JSON output: ${trimmed.slice(0, 200)}`);
    return JSON.parse(match[0]);
  }
}

async function callModel(client, config, input, systemPrompt, schemaName, schema) {
  const response = await client.responses.create(
    {
      model: config.model,
      instructions: systemPrompt,
      input,
      reasoning: { effort: config.reasoningEffort },
      max_output_tokens: config.maxOutputTokens,
      text: {
        format: {
          type: "json_schema",
          name: schemaName,
          strict: true,
          schema,
        },
      },
    },
    { timeout: config.timeoutMs }
  );
  return parseJson(response.output_text);
}

function fallbackDraft(templateDraft, reason) {
  return {
    angle: {
      label: "Template fallback — manual rewrite required",
      fit: reason,
    },
    message: templateDraft.message,
    withheld: false,
    reason,
    source: "template_fallback",
    fallbackInvoked: true,
  };
}

function manualReviewDraft(reason) {
  return {
    angle: {
      label: "Manual profile research required",
      fit: reason,
    },
    message: "",
    withheld: true,
    reason,
    source: "llm_manual_review",
    fallbackInvoked: false,
  };
}

function appendLog(config, entry) {
  const safeEntry = {
    ...entry,
    apiKeyPresent: Boolean(config.apiKey),
    apiKey: undefined,
  };
  fs.appendFileSync(config.logPath, `${JSON.stringify(safeEntry)}\n`, { mode: 0o600 });
}

async function generateLlmOutreachDraft({ context, templateDraft, config = llmConfigFromEnv() }) {
  const startedAt = new Date().toISOString();
  const audit = {
    startedAt,
    model: config.model,
    context,
    selectedConversationStrategy: "",
    firstPassDraft: "",
    critiqueResult: null,
    finalDraft: "",
    fallbackInvoked: false,
  };

  if (!config.apiKey) {
    const reason = "OPENAI_API_KEY is not configured.";
    const draft = config.fallbackBehavior === "template"
      ? fallbackDraft(templateDraft, reason)
      : manualReviewDraft(reason);
    audit.finalDraft = draft.message;
    audit.fallbackInvoked = draft.fallbackInvoked;
    appendLog(config, { ...audit, error: reason });
    return { draft, audit };
  }

  const client = new OpenAI({ apiKey: config.apiKey });

  try {
    const generation = await callModel(
      client,
      config,
      outreachUserPrompt(context),
      outreachSystemPrompt(),
      "outreach_generation",
      generationSchema
    );

    audit.selectedConversationStrategy = generation.selectedConversationStrategy || "";
    audit.firstPassDraft = generation.draft || "";

    if (!generation.shouldDraft) {
      const reason = generation.manualReviewReason || "The model found insufficient personalization context.";
      const draft = manualReviewDraft(reason);
      audit.finalDraft = "";
      audit.critiqueResult = { approved: false, manualReviewRequired: true, reasons: [reason] };
      appendLog(config, audit);
      return { draft, audit };
    }

    const critique = await callModel(
      client,
      config,
      critiqueUserPrompt(context, generation),
      critiqueSystemPrompt(),
      "outreach_critique",
      critiqueSchema
    );
    audit.critiqueResult = critique;

    if (critique.manualReviewRequired) {
      const reason = critique.manualReviewReason || "The critique pass requires manual profile research.";
      const draft = manualReviewDraft(reason);
      audit.finalDraft = "";
      appendLog(config, audit);
      return { draft, audit };
    }

    const finalMessage = critique.approved
      ? generation.draft
      : critique.revisedDraft;

    const draft = {
      angle: {
        label: critique.finalAngle || generation.selectedAngle || "LLM-selected conversation angle",
        fit: generation.rationale || "Selected by the runtime LLM generation workflow.",
      },
      message: finalMessage || "",
      withheld: !finalMessage,
      reason: generation.rationale || "Selected by the runtime LLM generation workflow.",
      source: "llm",
      fallbackInvoked: false,
      selectedConversationStrategy:
        critique.finalConversationStrategy || generation.selectedConversationStrategy || "",
    };

    if (!draft.message) {
      const reason = "The critique pass did not approve or provide a usable draft.";
      const fallback = config.fallbackBehavior === "template"
        ? fallbackDraft(templateDraft, reason)
        : manualReviewDraft(reason);
      audit.finalDraft = fallback.message;
      audit.fallbackInvoked = fallback.fallbackInvoked;
      appendLog(config, { ...audit, error: reason });
      return { draft: fallback, audit };
    }

    audit.finalDraft = draft.message;
    appendLog(config, audit);
    return { draft, audit };
  } catch (error) {
    const reason = `LLM generation failed: ${error.message}`;
    const draft = config.fallbackBehavior === "template"
      ? fallbackDraft(templateDraft, reason)
      : manualReviewDraft(reason);
    audit.finalDraft = draft.message;
    audit.fallbackInvoked = draft.fallbackInvoked;
    appendLog(config, { ...audit, error: reason });
    return { draft, audit };
  }
}

module.exports = {
  critiqueSystemPrompt,
  critiqueUserPrompt,
  generateLlmOutreachDraft,
  llmConfigFromEnv,
  outreachSystemPrompt,
  outreachUserPrompt,
};
