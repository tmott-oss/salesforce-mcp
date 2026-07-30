const fs = require("fs");
const path = require("path");
const jsforce = require("../node_modules/jsforce");
require("dotenv").config();

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.split("=");
  args.set(key.replace(/^--/, ""), value ?? "1");
}

const limit = Number(args.get("limit") || 5);
const offset = Number(args.get("offset") || 0);
const days = Number(args.get("days") || 180);
const deliver = args.get("deliver") || "console";
const remember = args.has("remember");
const resetSeen = args.has("reset-seen");
const markReview = args.has("mark-review");
const tokenPath =
  process.env.SF_TOKEN_PATH ||
  path.join(process.cwd(), ".sf-auth.json");
const seenPath = path.join(process.cwd(), ".daily-outreach-seen.json");
const manualReviewField = "Manual_Profile_Review_Required__c";
const sender = {
  name: process.env.OUTREACH_SENDER_NAME || "Troy Mott",
  exactTitle: process.env.OUTREACH_SENDER_TITLE || "VP of AI Operations",
  company: process.env.OUTREACH_SENDER_COMPANY || "Halosight",
  functionalRole:
    process.env.OUTREACH_SENDER_FUNCTIONAL_ROLE ||
    "leading AI operations",
  workContext:
    process.env.OUTREACH_SENDER_WORK_CONTEXT ||
    "customer intelligence and sales execution",
};
const slack = {
  token: process.env.SLACK_BOT_TOKEN || "",
  channelId: process.env.SLACK_CHANNEL_ID || "",
  manualReviewLimit: Number(process.env.SLACK_MANUAL_REVIEW_LIMIT || 0),
};

function readAuth() {
  if (!fs.existsSync(tokenPath)) {
    throw new Error(`Salesforce auth file not found: ${tokenPath}`);
  }
  return JSON.parse(fs.readFileSync(tokenPath, "utf8"));
}

function readSeenLeadIds() {
  if (resetSeen && fs.existsSync(seenPath)) {
    fs.unlinkSync(seenPath);
  }
  if (!fs.existsSync(seenPath)) return new Set();
  const parsed = JSON.parse(fs.readFileSync(seenPath, "utf8"));
  return new Set(Array.isArray(parsed.leadIds) ? parsed.leadIds : []);
}

function writeSeenLeadIds(seenLeadIds) {
  fs.writeFileSync(
    seenPath,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        leadIds: [...seenLeadIds].sort(),
      },
      null,
      2
    )
  );
}

function scoreLead(lead) {
  const title = (lead.Title || "").toLowerCase();
  const company = (lead.Company || "").toLowerCase();
  let score = 0;
  const reasons = [];

  const strongPersona = [
    "sales",
    "commercial",
    "revenue",
    "enablement",
    "go to market",
    "gtm",
    "field",
    "national account",
    "business transformation",
    "strategy",
    "operations",
    "customer success",
    "customer experience",
    "digital transformation",
    "ai strategy",
  ];
  const seniority = [
    "chief",
    "ceo",
    "president",
    "vp",
    "vice president",
    "director",
    "head",
    "general manager",
  ];
  const weakFit = ["software", "developer", "engineer", "student", "intern"];

  for (const keyword of strongPersona) {
    if (title.includes(keyword)) {
      score += 2;
      reasons.push(`persona keyword: ${keyword}`);
    }
  }
  for (const keyword of seniority) {
    if (title.includes(keyword)) {
      score += 1;
      reasons.push(`seniority keyword: ${keyword}`);
    }
  }
  for (const keyword of weakFit) {
    if (title.includes(keyword)) {
      score -= 2;
      reasons.push(`possible weak fit: ${keyword}`);
    }
  }
  if (company && !["test", "lead", "unknown"].some((bad) => company.includes(bad))) {
    score += 1;
  }

  return {
    score,
    fit: score >= 5 ? "High" : score >= 3 ? "Medium" : "Low",
    reasons: reasons.slice(0, 4),
  };
}

function classifyExecutive(lead) {
  const title = (lead.Title || "").toLowerCase();

  const lowPriority = [
    "hr",
    "human resources",
    "procurement",
    "legal",
    "audit",
    "erp",
    "pmo",
  ];
  if (lowPriority.some((keyword) => title.includes(keyword))) {
    return {
      persona: "Low Priority",
      priority: "Skip unless there is a strategic reason",
      reason: "Role is not closely tied to sales execution, customer-facing operations, or AI transformation.",
    };
  }

  const tier1 = [
    "sales",
    "commercial",
    "revenue",
    "customer success",
    "sales enablement",
    "enablement",
    "commercial operations",
    "sales operations",
    "national account",
    "field",
    "operations",
  ];
  if (tier1.some((keyword) => title.includes(keyword))) {
    return {
      persona: "Tier 1 Buyer",
      priority: "Pursue",
      reason: "Role is close to revenue execution, customer-facing teams, or sales operating discipline.",
    };
  }

  const strategicInfluencer = [
    "cio",
    "cto",
    "chief information",
    "chief technology",
    "chief digital",
    "digital",
    "ai",
    "transformation",
    "strategy",
  ];
  if (strategicInfluencer.some((keyword) => title.includes(keyword))) {
    return {
      persona: "Strategic Influencer",
      priority: "Pursue",
      reason: "Role can influence transformation, AI adoption, or operating-model decisions.",
    };
  }

  const isVicePresident = /\b(vp|vice president)\b/.test(title);
  const sponsor = ["ceo", "chief executive", "coo", "chief operating"];
  if (sponsor.some((keyword) => title.includes(keyword)) || (title.includes("president") && !isVicePresident)) {
    return {
      persona: "Executive Sponsor",
      priority: "Pursue thoughtfully",
      reason: "Role is senior enough for leadership-level conversation, but the first touch should stay broad and non-commercial.",
    };
  }

  return {
    persona: "General Executive",
    priority: "Review",
    reason: "Title has some potential, but fit should be confirmed from the Sales Navigator profile.",
  };
}

function firstName(name) {
  return (name || "").split(/\s+/)[0] || "there";
}

function chooseConversationStyle(lead, persona, offset = 0) {
  const title = (lead.Title || "").toLowerCase();
  const seed =
    [...(lead.Id || lead.Name || "")].reduce((sum, char) => sum + char.charCodeAt(0), 0) +
    offset;

  if (persona === "Executive Sponsor") return "CEO / executive leadership";
  if (title.includes("ai") || title.includes("digital") || title.includes("transformation")) {
    return seed % 2 === 0 ? "Shared journey" : "Respectful contrarian";
  }
  if (title.includes("sales") || title.includes("commercial") || title.includes("enablement")) {
    return ["Observation", "Shared problem", "Challenge conventional thinking"][seed % 3];
  }
  if (title.includes("customer success") || title.includes("customer experience")) {
    return "Their own words / customer friction";
  }
  if (title.includes("operations") || title.includes("strategy")) {
    return seed % 2 === 0 ? "Observation" : "Genuine curiosity";
  }
  return ["Observation", "Career journey", "Genuine curiosity"][seed % 3];
}

function messageContext(lead) {
  const first = firstName(lead.Name);
  const title = lead.Title || "your current role";
  const company = lead.Company || "your organization";
  return { first, title, company };
}

function hasAny(value, keywords) {
  const normalized = (value || "").toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword));
}

function personalizationProfile(lead, classification) {
  const title = lead.Title || "";
  const company = lead.Company || "";
  const hasTitle = Boolean(title.trim());
  const hasCompany = Boolean(company.trim());
  const scopeSignals = [
    "regional",
    "local",
    "global",
    "national",
    "field",
    "channel",
    "vendor",
    "partner",
    "data center",
    "enablement",
    "operations",
    "transformation",
    "strategy",
    "customer success",
    "customer experience",
    "account",
  ];

  if (classification.persona === "Low Priority" || !hasTitle || !hasCompany) {
    return {
      level: "Persona-only",
      confidence: "Low",
      signal: "Insufficient role/company signal in Salesforce.",
      manualReviewRequired: true,
    };
  }

  if (hasAny(title, scopeSignals)) {
    return {
      level: "Role-specific",
      confidence: "Medium",
      signal: "Title includes a distinctive responsibility or scope signal.",
      manualReviewRequired: false,
    };
  }

  if (classification.persona === "Tier 1 Buyer" || classification.persona === "Strategic Influencer") {
    return {
      level: "Role-specific",
      confidence: "Medium",
      signal: "Title maps to a relevant buyer or influencer persona.",
      manualReviewRequired: false,
    };
  }

  return {
    level: "Persona-only",
    confidence: "Low",
    signal: "Only general title/company context is available.",
    manualReviewRequired: true,
  };
}

function outreachAngle(lead, classification, style) {
  const { title } = messageContext(lead);
  const lowerTitle = title.toLowerCase();

  if (classification.persona === "Executive Sponsor") {
    return {
      label: "Scaling consistent execution without adding drag",
      fit: "The role is senior enough for a broad operational observation about consistency, execution, and organizational friction.",
    };
  }

  if (hasAny(lowerTitle, ["regional"])) {
    return {
      label: "Visibility across many teams and accounts",
      fit: "Regional sales leadership depends on seeing risks, commitments, and account context without forcing extra reporting work.",
    };
  }

  if (hasAny(lowerTitle, ["local"])) {
    return {
      label: "Preserving local customer knowledge",
      fit: "Local sales leadership often depends on relationship context that is hard to preserve across reps, territories, and managers.",
    };
  }

  if (hasAny(lowerTitle, ["sales operations", "commercial operations", "enablement", "strategy"])) {
    return {
      label: "Turning strategy into cleaner field execution",
      fit: "Sales operations and enablement roles sit near CRM quality, workflow friction, process adoption, and rep context.",
    };
  }

  if (hasAny(lowerTitle, ["operations", "customer experience", "customer success"])) {
    return {
      label: "Customer commitments reaching the teams responsible for execution",
      fit: "Operations and customer roles depend on clean handoffs, accurate context, and visibility into what customers were promised.",
    };
  }

  if (hasAny(lowerTitle, ["vendor", "channel", "partner"])) {
    return {
      label: "Coordinating customer context across partners and internal teams",
      fit: "Vendor and channel roles need consistent information flow across customers, partners, and internal owners.",
    };
  }

  if (hasAny(lowerTitle, ["ai", "digital", "transformation", "technology", "cio", "cto"])) {
    return {
      label: "Operationalizing AI without creating more work",
      fit: "Technology and transformation leaders need adoption paths that improve execution without adding noise for customer-facing teams.",
    };
  }

  if (hasAny(lowerTitle, ["sales", "commercial", "revenue", "account", "field"])) {
    return style === "Challenge conventional thinking"
      ? {
          label: "Sales friction hiding inside post-meeting work",
          fit: "Sales leaders own the gap between customer conversations, CRM quality, next steps, and rep productivity.",
        }
      : {
          label: "Customer intelligence trapped outside the CRM",
          fit: "Sales leaders need the context, risks, commitments, and account changes behind activity records, not activity alone.",
        };
  }

  return {
    label: "Manual profile review needed before outreach",
    fit: "The Salesforce record does not contain enough specific evidence to support a confident personalized message.",
  };
}

function stableSeed(value) {
  return [...(value || "")].reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

function credibilityLine(lead, focus) {
  const lowerFocus = focus.toLowerCase();
  if (lowerFocus.includes("preserve account context") || lowerFocus.includes("preserving account knowledge")) {
    return `Much of my work at ${sender.company} focuses on ${focus}.`;
  }
  if (lowerFocus.includes("signals visible") || lowerFocus.includes("visible earlier")) {
    return `A significant part of my work as ${sender.exactTitle} at ${sender.company} is focused on ${focus}.`;
  }
  if (lowerFocus.includes("structured account intelligence") || lowerFocus.includes("clearer handoffs")) {
    return `The work I lead at ${sender.company} is tied to that exact gap: ${focus}.`;
  }
  if (lowerFocus.includes("routing important customer context")) {
    return `At ${sender.company}, my work often sits right at that intersection of ${focus}.`;
  }
  if (lowerFocus.includes("useful account context") || lowerFocus.includes("more admin for sellers")) {
    return `In my role ${sender.functionalRole} at ${sender.company}, I spend a lot of time thinking about ${focus}.`;
  }
  if (lowerFocus.includes("post-meeting workflow")) {
    return `That is one of the operating problems I spend time on as ${sender.exactTitle} at ${sender.company}: ${focus}.`;
  }
  if (lowerFocus.includes("conversation context") || lowerFocus.includes("ordinary customer-facing work")) {
    return `That problem sits directly within the work I lead at ${sender.company} around ${focus}.`;
  }

  const seed = stableSeed(`${lead.Id || lead.Name}:${focus}`);
  const variants = [
    `A significant part of my work as ${sender.exactTitle} at ${sender.company} is focused on ${focus}.`,
    `That is one of the operating problems I spend time on as ${sender.exactTitle} at ${sender.company}: ${focus}.`,
    `That is a big part of my lane as ${sender.exactTitle} at ${sender.company}: ${focus}.`,
    `At ${sender.company}, my work as ${sender.exactTitle} often sits right at that intersection of ${focus}.`,
    `That problem sits directly within the work I lead at ${sender.company} around ${focus}.`,
    `Much of my work at ${sender.company} focuses on ${focus}.`,
    `In my role ${sender.functionalRole} at ${sender.company}, I spend a lot of time thinking about ${focus}.`,
    `That challenge is closely connected to the work I lead around ${sender.workContext}.`,
    `The work I lead at ${sender.company} is tied to that exact gap: ${focus}.`,
    `That is the kind of workflow problem we are trying to make easier at ${sender.company}: ${focus}.`,
  ];
  return variants[seed % variants.length];
}

function titleMatches(title, keywords) {
  return hasAny(title, keywords);
}

function chooseVariant(lead, variants, batchState) {
  const company = (lead.Company || "unknown").toLowerCase();
  const seed = stableSeed(`${lead.Id || lead.Name}:${lead.Title}:${lead.Company}`);
  const ordered = variants
    .map((variant, index) => ({ variant, index }))
    .sort((a, b) => ((seed + a.index) % variants.length) - ((seed + b.index) % variants.length));

  for (const { variant } of ordered) {
    const angleKey = variant.angle.label.toLowerCase();
    const companyAngleKey = `${company}:${angleKey}`;
    if (!batchState.usedAngles.has(angleKey) && !batchState.usedCompanyAngles.has(companyAngleKey)) {
      batchState.usedAngles.add(angleKey);
      batchState.usedCompanyAngles.add(companyAngleKey);
      return variant;
    }
  }

  const fallback = ordered[0].variant;
  batchState.usedAngles.add(fallback.angle.label.toLowerCase());
  batchState.usedCompanyAngles.add(`${company}:${fallback.angle.label.toLowerCase()}`);
  return fallback;
}

function makeDraft(angle, message, reason) {
  return {
    angle,
    message,
    withheld: false,
    reason,
  };
}

function salesVariants(lead) {
  const { first, company } = messageContext(lead);
  return [
    makeDraft(
      {
        label: "Customer intelligence not making it back into CRM",
        fit: "Sales leaders need more than activity history; they need the context behind risks, commitments, and account changes.",
      },
      `Hi ${first}, sales teams often generate their best account intelligence in live customer conversations, but only a thin version of that context makes it back into CRM. That creates blind spots around commitments, risks, objections, and next steps. ${credibilityLine(lead, "turning customer conversations into useful account context without adding more admin for sellers")} Do you see that gap more as a rep-productivity issue or a manager-visibility issue?`,
      "Sales leaders own the gap between customer conversations, CRM quality, next steps, and rep productivity."
    ),
    makeDraft(
      {
        label: "Post-meeting follow-through becoming the hidden sales bottleneck",
        fit: "Sales execution often breaks after the meeting, when notes, next steps, and internal follow-up are incomplete.",
      },
      `Hi ${first}, a lot of sales execution risk shows up after the customer meeting. The conversation may be strong, but the notes are partial, the internal follow-up is uneven, and the next step depends too much on memory. ${credibilityLine(lead, "making the post-meeting workflow cleaner without pulling reps away from selling")} Do you think leaders underestimate how much pipeline quality depends on what happens after the call?`,
      "The message fits a sales leader responsible for translating activity into reliable execution."
    ),
    makeDraft(
      {
        label: "Creating sales consistency without scripting the field",
        fit: "Local and field sales leaders need consistency while preserving the judgment that makes reps effective.",
      },
      `Hi ${first}, the best sales organizations seem to face a tricky balance: creating consistency without turning good sellers into script followers. Reps need better context and cleaner follow-through, but not another layer of reporting. ${credibilityLine(lead, "helping teams preserve account context while reducing administrative drag")} I would be curious how ${company} thinks about consistency without flattening local judgment.`,
      "The message fits revenue leaders who need consistent execution without adding process friction."
    ),
  ];
}

function localSalesVariants(lead) {
  const { first, company } = messageContext(lead);
  return [
    makeDraft(
      {
        label: "Preserving local customer knowledge",
        fit: "Local sales leadership depends on territory and relationship knowledge that is hard to preserve in CRM.",
      },
      `Hi ${first}, local sales teams often win because reps know the territory, customer history, and informal account context in ways CRM rarely captures. The risk is that this knowledge becomes fragile when territories shift or managers change. ${credibilityLine(lead, "preserving account knowledge without adding more administrative work for the field")} How do you think about protecting local judgment while still creating consistency at scale?`,
      "Local sales leadership often depends on relationship context that is hard to preserve across reps, territories, and managers."
    ),
    makeDraft(
      {
        label: "Territory transitions exposing account-memory gaps",
        fit: "Local sales teams are vulnerable when account history lives with individuals instead of the operating system.",
      },
      `Hi ${first}, one challenge in local sales is that account memory often lives with individual reps rather than the organization. When coverage changes, the subtle context around relationships, commitments, and customer preferences can disappear. ${credibilityLine(lead, "turning everyday customer conversations into durable account intelligence")} Does that knowledge-transfer problem show up during territory or personnel changes?`,
      "The message fits local sales leaders responsible for account continuity and field execution."
    ),
  ];
}

function operationsVariants(lead) {
  const { first } = messageContext(lead);
  return [
    makeDraft(
      {
        label: "Customer commitments not reaching operations cleanly",
        fit: "Operations leaders depend on accurate handoffs from customer-facing teams.",
      },
      `Hi ${first}, operations teams can inherit risk from conversations they were not part of. A customer expectation, constraint, or commitment may be discussed in the field, but the handoff often arrives late or without enough context. ${credibilityLine(lead, "turning customer conversations into structured account intelligence and clearer handoffs")} Where do you see the most friction: incomplete context, late escalation, or unclear ownership?`,
      "Operations leaders depend on clean handoffs, accurate context, and visibility into what customers were promised."
    ),
    makeDraft(
      {
        label: "Execution risk hiding between sales and operations",
        fit: "Operations leaders need early visibility into customer changes before they become delivery issues.",
      },
      `Hi ${first}, sales-to-operations handoffs are often where small gaps become execution risk. The issue usually is not effort; it is that customer context, timing changes, and follow-up details are scattered across notes, calls, and inboxes. ${credibilityLine(lead, "making those signals visible earlier in the customer workflow")} From an operations perspective, how much preventable friction starts with context that arrived too late?`,
      "The message fits operations leaders who own execution quality and cross-functional follow-through."
    ),
    makeDraft(
      {
        label: "Customer changes not becoming operational signals",
        fit: "Operations teams need changes in customer expectations to become structured signals, not informal anecdotes.",
      },
      `Hi ${first}, customer-facing teams hear early signals all the time: changing expectations, service concerns, timing pressure, and small commitments that later matter operationally. The hard part is converting those signals into something the right team can act on. ${credibilityLine(lead, "routing important customer context to the people responsible for execution")} How often do operational surprises begin as information someone already heard but did not capture clearly?`,
      "The message fits operations leaders who need better visibility into customer-driven execution risk."
    ),
  ];
}

function strategyEnablementVariants(lead) {
  const { first } = messageContext(lead);
  return [
    makeDraft(
      {
        label: "Strategy breaking down in field execution",
        fit: "Sales strategy and enablement roles sit close to CRM quality, workflow adoption, and field execution.",
      },
      `Hi ${first}, sales strategy usually looks cleanest before it reaches the field. The hard part is making the workflow useful enough that reps actually keep the customer context, next steps, and CRM detail current. ${credibilityLine(lead, "reducing workflow friction while improving the quality of account intelligence")} Do you see adoption problems more as a process-design issue or a seller-context issue?`,
      "Sales operations and enablement roles sit near CRM quality, workflow friction, process adoption, and rep context."
    ),
    makeDraft(
      {
        label: "Enablement losing visibility into what happens after customer conversations",
        fit: "Enablement leaders need visibility into the real customer interactions that shape coaching and execution.",
      },
      `Hi ${first}, enablement teams are often asked to improve execution using lagging indicators, incomplete notes, and CRM fields that do not explain what actually happened with the customer. ${credibilityLine(lead, "capturing conversation context in a way that supports better coaching and follow-through")} Do you think the bigger gap is data quality or visibility into the conversation itself?`,
      "The message fits enablement leaders responsible for improving execution without adding rep burden."
    ),
  ];
}

function technologyVariants(lead) {
  const { first } = messageContext(lead);
  return [
    makeDraft(
      {
        label: "Operationalizing AI inside customer-facing workflows",
        fit: "Technology and transformation leaders need adoption paths that improve execution without adding noise.",
      },
      `Hi ${first}, AI becomes valuable in customer-facing teams only when it fits the work people already do. Otherwise it creates another layer of noise around notes, CRM updates, and follow-through. ${credibilityLine(lead, "turning conversation context into cleaner actions and account intelligence")} Do you see adoption risk showing up more as a technology issue or a workflow issue?`,
      "The message fits leaders responsible for AI, digital transformation, or technology adoption."
    ),
    makeDraft(
      {
        label: "AI adoption depending on trust in the workflow",
        fit: "AI leaders need systems that produce trusted, usable outputs rather than more noise.",
      },
      `Hi ${first}, I am becoming convinced that the hardest part of AI adoption is not the model; it is whether teams trust the workflow it creates. In sales and operations, that means capturing customer context accurately enough to support real follow-through. ${credibilityLine(lead, "making AI useful inside ordinary customer-facing work")} What do you think matters more for adoption: accuracy, workflow fit, or trust?`,
      "The message fits transformation leaders focused on practical AI adoption."
    ),
  ];
}

function executiveVariants(lead) {
  const { first, company } = messageContext(lead);
  return [
    makeDraft(
      {
        label: "Scaling consistent execution without adding drag",
        fit: "Senior operators care about consistency, speed, and visibility across teams.",
      },
      `Hi ${first}, as organizations grow, execution often gets harder because customer context becomes scattered across conversations, teams, and individual memory. Leaders need visibility without asking the field for more reporting. ${credibilityLine(lead, "preserving customer context so leaders can see what is changing without slowing teams down")} How do you think about balancing consistency and speed at ${company}?`,
      "The role is senior enough for a broad operational observation about consistency, execution, and organizational friction."
    ),
    makeDraft(
      {
        label: "Leadership visibility without more process",
        fit: "Senior leaders need a clearer operating picture without burdening customer-facing teams.",
      },
      `Hi ${first}, one pattern I keep seeing is that leadership wants better visibility into customer risk and execution quality, but the usual answer is more process for the people closest to the customer. ${credibilityLine(lead, "capturing useful customer intelligence without adding another reporting layer")} Do you think better visibility has to come with more process, or can the workflow get lighter?`,
      "The message fits senior leaders responsible for scaling execution across teams."
    ),
  ];
}

function draftMessage(lead, classification, style, profile, batchState = { usedAngles: new Set(), usedCompanyAngles: new Set() }) {
  const { first, title, company } = messageContext(lead);
  const lowerTitle = title.toLowerCase();
  const angle = outreachAngle(lead, classification, style);

  if (profile.confidence === "Low") {
    return {
      angle,
      message: "",
      withheld: true,
      reason: "Low personalization confidence. Review the Sales Navigator profile before drafting.",
    };
  }

  if (classification.persona === "Executive Sponsor") {
    return chooseVariant(lead, executiveVariants(lead), batchState);
  }

  if (titleMatches(lowerTitle, ["ai", "digital", "transformation", "technology", "cio", "cto"])) {
    return chooseVariant(lead, technologyVariants(lead), batchState);
  }

  if (titleMatches(lowerTitle, ["customer success", "customer experience"])) {
    return chooseVariant(lead, operationsVariants(lead), batchState);
  }

  if (titleMatches(lowerTitle, ["local"])) {
    return chooseVariant(lead, localSalesVariants(lead), batchState);
  }

  if (titleMatches(lowerTitle, ["operations"])) {
    return chooseVariant(lead, operationsVariants(lead), batchState);
  }

  if (titleMatches(lowerTitle, ["enablement", "sales operations", "commercial operations", "strategy"])) {
    return chooseVariant(lead, strategyEnablementVariants(lead), batchState);
  }

  if (titleMatches(lowerTitle, ["sales", "commercial", "revenue", "account", "field"])) {
    return chooseVariant(lead, salesVariants(lead), batchState);
  }

  return {
    angle,
    message: "",
    withheld: true,
    reason: "The title does not provide enough specific signal for a strong first message.",
  };
}

async function findManualReviewField(conn) {
  const describe = await conn.sobject("Lead").describe();
  return describe.fields.some((field) => field.name === manualReviewField && field.updateable);
}

function slackEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function slackLink(url, label) {
  return `<${url}|${slackEscape(label)}>`;
}

async function postSlackMessage({ text, threadTs, blocks }) {
  if (!slack.token || !slack.channelId) {
    throw new Error("Slack delivery requires SLACK_BOT_TOKEN and SLACK_CHANNEL_ID in .env.");
  }

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${slack.token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: slack.channelId,
      text,
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false,
      ...(blocks ? { blocks } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) {
    throw new Error(`Slack post failed: ${body.error || response.statusText}`);
  }
  return body;
}

function leadLinks(auth, lead) {
  const links = [
    slackLink(`${auth.instanceUrl}/lightning/r/Lead/${lead.Id}/view`, "Salesforce"),
  ];
  if (lead.Sales_Navigator_URL__c) links.push(slackLink(lead.Sales_Navigator_URL__c, "Sales Navigator"));
  return links.join(" | ");
}

function slackButtonText(text) {
  return {
    type: "plain_text",
    text,
    emoji: true,
  };
}

function parentBlocks(summary, nextOffset) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: summary,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: slackButtonText("Next 5"),
          action_id: "outreach_next_batch",
          value: JSON.stringify({ offset: nextOffset, limit: 5 }),
        },
      ],
    },
  ];
}

function leadBlocks(item, index, auth) {
  const { lead, scoring, classification, draft, personalization, activity } = item;
  const salesforceUrl = `${auth.instanceUrl}/lightning/r/Lead/${lead.Id}/view`;
  const buttonElements = [
    {
      type: "button",
      text: slackButtonText("Open Salesforce"),
      url: salesforceUrl,
      action_id: "open_salesforce",
    },
  ];
  if (lead.Sales_Navigator_URL__c) {
    buttonElements.push({
      type: "button",
      text: slackButtonText("Open Sales Nav"),
      url: lead.Sales_Navigator_URL__c,
      action_id: "open_sales_nav",
    });
  }
  buttonElements.push(
    {
      type: "button",
      text: slackButtonText("Mark Sent"),
      action_id: "outreach_mark_sent",
      value: JSON.stringify({ leadId: lead.Id, leadName: lead.Name }),
      style: "primary",
    },
    {
      type: "button",
      text: slackButtonText("Needs Review"),
      action_id: "outreach_needs_review",
      value: JSON.stringify({ leadId: lead.Id, leadName: lead.Name }),
    }
  );

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${index + 1}. ${slackEscape(lead.Name)}* — ${slackEscape(lead.Title || "-")} at ${slackEscape(lead.Company || "-")}\n*Fit:* ${scoring.fit} (${scoring.score}) | *Persona:* ${classification.persona} | *Confidence:* ${personalization.confidence}\n*Angle:* ${slackEscape(draft.angle.label)}\n*Prior LinkedIn steps:* ${slackEscape(activity.map((task) => task.Subject).join(", ") || "none")}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Draft message:*\n>${slackEscape(draft.message)}`,
      },
    },
    {
      type: "actions",
      elements: buttonElements,
    },
  ];
}

function formatSlackLead(item, index, auth) {
  const { lead, scoring, classification, draft, personalization, activity } = item;
  return [
    `*${index + 1}. ${slackEscape(lead.Name)}* — ${slackEscape(lead.Title || "-")} at ${slackEscape(lead.Company || "-")}`,
    `*Fit:* ${scoring.fit} (${scoring.score}) | *Persona:* ${classification.persona} | *Confidence:* ${personalization.confidence}`,
    `*Angle:* ${slackEscape(draft.angle.label)}`,
    `*Prior LinkedIn steps:* ${slackEscape(activity.map((task) => task.Subject).join(", ") || "none")}`,
    `*Links:* ${leadLinks(auth, lead)}`,
    `*Draft message:*`,
    `>${slackEscape(draft.message)}`,
  ].join("\n");
}

function formatSlackManualReview(item, auth) {
  const { lead, scoring, classification, personalization } = item;
  return `• *${slackEscape(lead.Name)}* — ${slackEscape(lead.Title || "-")} at ${slackEscape(lead.Company || "-")} | Fit: ${scoring.fit} | Persona: ${classification.persona} | ${slackEscape(personalization.signal)} | ${leadLinks(auth, lead)}`;
}

async function deliverToSlack({ auth, identity, since, leads, messagedLeadIds, seenLeadIds, eligibleQueue, readyQueue, manualReviewQueue, queue, nextOffset }) {
  const summary = [
    `*Daily Sales Nav Outreach Queue*`,
    `Sender: ${slackEscape(sender.name)}, ${slackEscape(sender.exactTitle)} at ${slackEscape(sender.company)}`,
    `Owner: ${slackEscape(identity.display_name)}`,
    `Window: Leads created since ${since}`,
    `Candidates reviewed: ${leads.length}`,
    `Already messaged in Salesforce: ${messagedLeadIds.size}`,
    `Skipped from local seen list: ${seenLeadIds.size}`,
    `Eligible remaining: ${eligibleQueue.length}`,
    `Ready for review: ${readyQueue.length}`,
    `Manual profile review required: ${manualReviewQueue.length}`,
    `Posting ${queue.length} ready lead(s) in this thread.`,
  ].join("\n");

  const parent = await postSlackMessage({
    text: summary,
    blocks: parentBlocks(summary, nextOffset),
  });
  for (const [index, item] of queue.entries()) {
    await postSlackMessage({
      text: formatSlackLead(item, index, auth),
      blocks: leadBlocks(item, index, auth),
      threadTs: parent.ts,
    });
  }

  if (manualReviewQueue.length && slack.manualReviewLimit > 0) {
    const visible = manualReviewQueue.slice(0, slack.manualReviewLimit);
    const hiddenCount = manualReviewQueue.length - visible.length;
    const manualText = [
      `*Manual Profile Review Required*`,
      `These low-confidence leads were not placed into the ready queue.`,
      "",
      ...visible.map((item) => formatSlackManualReview(item, auth)),
      hiddenCount > 0 ? `• ...and ${hiddenCount} more` : "",
    ].filter(Boolean).join("\n");
    await postSlackMessage({ text: manualText, threadTs: parent.ts });
  }

  return parent;
}

async function main() {
  if (!["console", "slack"].includes(deliver)) {
    throw new Error(`Unsupported delivery target: ${deliver}. Use --deliver=console or --deliver=slack.`);
  }
  if (deliver === "slack" && (!slack.token || !slack.channelId)) {
    throw new Error("Slack delivery requires SLACK_BOT_TOKEN and SLACK_CHANNEL_ID in .env.");
  }

  const auth = readAuth();
  const conn = new jsforce.Connection({
    instanceUrl: auth.instanceUrl,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    oauth2: {
      loginUrl: process.env.SF_LOGIN_URL || "https://login.salesforce.com",
      clientId: process.env.SF_CLIENT_ID || auth.clientId || "",
    },
  });

  const identity = await conn.identity();
  const seenLeadIds = readSeenLeadIds();
  const canMarkManualReview = markReview ? await findManualReviewField(conn) : false;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const leadQuery = `
    SELECT Id, Name, Company, Title, Status, LeadSource, CreatedDate, LastActivityDate,
           LinkedIn_Connection_Status__c, LinkedIn_Conversation_Stage__c,
           LinkedIn_Last_Touch_Date__c, Sales_Navigator_URL__c, LinkedIn_Profile_URL__c
    FROM Lead
    WHERE IsConverted = false
      AND OwnerId = '${identity.user_id}'
      AND CreatedDate >= ${since}T00:00:00Z
      AND Status IN ('Cold/ Not Started', 'Approaching')
    ORDER BY CreatedDate DESC
    LIMIT 200
  `;

  const leadsResult = await conn.query(leadQuery);
  const leads = leadsResult.records.filter((lead) => {
    const name = (lead.Name || "").toLowerCase();
    const company = (lead.Company || "").toLowerCase();
    return (
      name !== "unknown" &&
      !company.includes("test") &&
      !company.includes("poller liveness")
    );
  });

  const leadIds = leads.map((lead) => `'${lead.Id}'`).join(",");
  let messagedLeadIds = new Set();
  let activityByLead = new Map();

  if (leadIds) {
    const tasks = await conn.query(`
      SELECT Id, WhoId, Subject, ActivityDate, Status, Type
      FROM Task
      WHERE WhoId IN (${leadIds})
        AND Status = 'Completed'
        AND (
          Subject LIKE 'LinkedIn Step%'
          OR Subject = 'Message sent from Sales Navigator'
          OR Subject LIKE 'InMail sent from Sales Navigator%'
          OR Subject LIKE 'Sales Navigator message sent%'
        )
      ORDER BY ActivityDate DESC
      LIMIT 500
    `);

    for (const task of tasks.records) {
      if (!activityByLead.has(task.WhoId)) activityByLead.set(task.WhoId, []);
      activityByLead.get(task.WhoId).push(task);
      if (/message|inmail/i.test(task.Subject || "")) messagedLeadIds.add(task.WhoId);
    }
  }

  const eligibleQueue = leads
    .filter((lead) => !messagedLeadIds.has(lead.Id))
    .filter((lead) => !seenLeadIds.has(lead.Id))
    .map((lead) => {
      const scoring = scoreLead(lead);
      const classification = classifyExecutive(lead);
      return {
        lead,
        scoring,
        classification,
        activity: activityByLead.get(lead.Id) || [],
      };
    })
    .sort((a, b) => {
      if (b.scoring.score !== a.scoring.score) return b.scoring.score - a.scoring.score;
      return new Date(b.lead.CreatedDate) - new Date(a.lead.CreatedDate);
    });

  const batchState = {
    usedAngles: new Set(),
    usedCompanyAngles: new Set(),
  };
  const reviewedQueue = eligibleQueue.map((item, index) => {
    const style = chooseConversationStyle(item.lead, item.classification.persona, offset + index);
    const personalization = personalizationProfile(item.lead, item.classification);
    const draft = draftMessage(item.lead, item.classification, style, personalization, batchState);
    return {
      ...item,
      style,
      personalization,
      draft,
    };
  });

  const readyQueue = reviewedQueue.filter((item) => !item.personalization.manualReviewRequired);
  const manualReviewQueue = reviewedQueue.filter((item) => item.personalization.manualReviewRequired);
  const queue = readyQueue.slice(offset, offset + limit);

  if (markReview && canMarkManualReview && manualReviewQueue.length) {
    const updates = manualReviewQueue.map((item) => ({
      Id: item.lead.Id,
      [manualReviewField]: true,
    }));
    await conn.sobject("Lead").update(updates, { allOrNone: false });
  }

  console.log(`# Daily Sales Nav Outreach Queue`);
  console.log("");
  console.log(`Generated: ${new Date().toLocaleString()}`);
  console.log(`Window: Leads created since ${since}`);
  console.log(`Owner: ${identity.display_name}`);
  console.log(`Sender context: ${sender.name}, ${sender.exactTitle} at ${sender.company}`);
  console.log(`Candidates reviewed: ${leads.length}`);
  console.log(`Already messaged in Salesforce: ${messagedLeadIds.size}`);
  console.log(`Skipped from local seen list: ${seenLeadIds.size}`);
  console.log(`Eligible remaining: ${eligibleQueue.length}`);
  console.log(`Ready for review: ${readyQueue.length}`);
  console.log(`Manual profile review required: ${manualReviewQueue.length}`);
  console.log(`Offset: ${offset}`);
  console.log(`Recommended today: ${queue.length}`);
  console.log(`Delivery: ${deliver}`);
  if (markReview && !canMarkManualReview) {
    console.log(`Manual review write-back skipped: Lead.${manualReviewField} does not exist yet.`);
  }
  console.log("");

  for (const [index, item] of queue.entries()) {
    const { lead, scoring, classification, style, activity, draft, personalization } = item;
    const url = `${auth.instanceUrl}/lightning/r/Lead/${lead.Id}/view`;
    console.log(`## ${index + 1}. ${lead.Name} - ${scoring.fit} fit (${scoring.score})`);
    console.log("");
    console.log(`- Company: ${lead.Company || "-"}`);
    console.log(`- Title: ${lead.Title || "-"}`);
    console.log(`- Persona: ${classification.persona}`);
    console.log(`- Recommendation: ${classification.priority}`);
    console.log(`- Conversation style: ${style}`);
    console.log(`- Personalization level: ${personalization.level}`);
    console.log(`- Confidence: ${personalization.confidence}`);
    console.log(`- Recommended problem angle: ${draft.angle.label}`);
    console.log(`- Status: ${lead.Status || "-"}`);
    console.log(`- Last LinkedIn touch: ${lead.LinkedIn_Last_Touch_Date__c || "-"}`);
    console.log(`- Prior LinkedIn steps: ${activity.map((task) => task.Subject).join(", ") || "none"}`);
    console.log(`- Why: ${classification.reason}`);
    console.log(`- Fit signals: ${scoring.reasons.join("; ") || "limited title/company signal"}`);
    console.log(`- Why this angle fits: ${draft.reason}`);
    console.log(`- Salesforce: ${url}`);
    if (lead.Sales_Navigator_URL__c) console.log(`- Sales Navigator: ${lead.Sales_Navigator_URL__c}`);
    console.log("");
    console.log(`Draft:`);
    console.log("");
    console.log(draft.message);
    console.log("");
  }

  if (manualReviewQueue.length) {
    console.log(`## Manual Profile Review Required`);
    console.log("");
    console.log(`These leads were not placed into the ready-for-review queue because personalization confidence is Low.`);
    console.log("");
    for (const item of manualReviewQueue.slice(0, 15)) {
      const { lead, scoring, classification, personalization } = item;
      const url = `${auth.instanceUrl}/lightning/r/Lead/${lead.Id}/view`;
      console.log(`- ${lead.Name} (${lead.Company || "-"}, ${lead.Title || "-"})`);
      console.log(`  Confidence: ${personalization.confidence}; Persona: ${classification.persona}; Fit: ${scoring.fit}; Reason: ${personalization.signal}; Salesforce: ${url}`);
    }
    if (manualReviewQueue.length > 15) {
      console.log(`- ...and ${manualReviewQueue.length - 15} more`);
    }
    console.log("");
  }

  if (deliver === "slack") {
    const post = await deliverToSlack({
      auth,
      identity,
      since,
      leads,
      messagedLeadIds,
      seenLeadIds,
      eligibleQueue,
      readyQueue,
      manualReviewQueue,
      queue,
      nextOffset: offset + limit,
    });
    console.log(`Posted Slack queue to channel ${slack.channelId} at thread ${post.ts}`);
    console.log("");
  }

  if (remember) {
    for (const item of queue) {
      seenLeadIds.add(item.lead.Id);
    }
    writeSeenLeadIds(seenLeadIds);
    console.log(`Saved ${queue.length} lead(s) to local seen list: ${seenPath}`);
    console.log("");
  }

  if (!remember) {
    console.log(`Tip: add --offset=${offset + limit} for the next ready batch, or add --remember to skip this batch next time.`);
    console.log(`Tip: after adding Lead.${manualReviewField}, use --mark-review to set low-confidence records for manual review in Salesforce.`);
    console.log("");
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
