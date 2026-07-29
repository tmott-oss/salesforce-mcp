const fs = require("fs");
const path = require("path");
const jsforce = require("../node_modules/jsforce");
require("dotenv").config();

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.split("=");
  args.set(key.replace(/^--/, ""), value ?? "1");
}

const limit = Number(args.get("limit") || 10);
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
  manualReviewLimit: Number(process.env.SLACK_MANUAL_REVIEW_LIMIT || 10),
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

function credibilityLine(lead, focus) {
  const seed = [...(lead.Id || lead.Name || "")].reduce(
    (sum, char) => sum + char.charCodeAt(0),
    0
  );
  const variants = [
    `A significant part of my work as ${sender.exactTitle} at ${sender.company} is focused on ${focus}.`,
    `That problem sits directly within the work I lead at ${sender.company} around ${focus}.`,
    `Much of my work at ${sender.company} focuses on ${focus}.`,
    `In my role ${sender.functionalRole} at ${sender.company}, I spend a lot of time thinking about ${focus}.`,
    `That challenge is closely connected to the work I lead around ${sender.workContext}.`,
  ];
  return variants[seed % variants.length];
}

function draftMessage(lead, classification, style, profile) {
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
    return {
      angle,
      message: `Hi ${first}, one leadership problem I keep coming back to is how companies create consistent execution without slowing good teams down. As organizations grow, the customer context behind decisions, risks, and commitments often gets scattered across conversations and individual memory. ${credibilityLine(lead, "preserving that context so leaders can see what is changing without adding more reporting work")} I would be interested in how you think about balancing consistency and speed at ${company}.`,
      withheld: false,
      reason: angle.fit,
    };
  }

  if (lowerTitle.includes("ai") || lowerTitle.includes("digital") || lowerTitle.includes("transformation")) {
    if (style === "Respectful contrarian") {
      return {
        angle,
        message: `Hi ${first}, I am becoming convinced that AI itself is not the advantage in customer-facing organizations. The harder problem is turning conversations, decisions, and follow-through into useful operating context without creating more work for the teams doing the work. ${credibilityLine(lead, "helping organizations capture that context more naturally and make it usable across sales and operations")} Do you see adoption risk showing up more as a technology issue or a workflow issue?`,
        withheld: false,
        reason: angle.fit,
      };
    }

    return {
      angle,
      message: `Hi ${first}, one area I have been exploring is how AI becomes useful inside the ordinary flow of customer-facing work. A lot of important account knowledge still lives in calls, notes, emails, and individual memory, which makes adoption harder than the strategy suggests. ${credibilityLine(lead, "turning raw conversation context into cleaner actions and account intelligence")} From your perspective, is the bigger challenge choosing what to automate or getting teams to trust the new workflow?`,
      withheld: false,
      reason: angle.fit,
    };
  }

  if (lowerTitle.includes("customer success") || lowerTitle.includes("customer experience")) {
    return {
      angle,
      message: `Hi ${first}, customer experience often breaks down in places customers never see directly: internal handoffs, incomplete context, missed commitments, and small requests that do not reach the right team. ${credibilityLine(lead, "capturing customer conversation context more accurately and routing the important pieces before they become friction")} From a customer experience perspective, how much of the work depends on improving what happens after the conversation?`,
      withheld: false,
      reason: angle.fit,
    };
  }

  if (lowerTitle.includes("sales") || lowerTitle.includes("commercial") || lowerTitle.includes("enablement")) {
    if (lowerTitle.includes("local")) {
      return {
        angle,
        message: `Hi ${first}, local sales teams often succeed because reps know the customer, the territory, and the account history in ways that never fully make it into CRM. The risk is that valuable context becomes fragile when territories shift, managers change, or follow-up depends on individual memory. ${credibilityLine(lead, "preserving account knowledge without adding more administrative work for the field")} I would be interested in how you think about protecting local judgment while still creating consistency at scale.`,
        withheld: false,
        reason: angle.fit,
      };
    }

    if (lowerTitle.includes("regional")) {
      return {
        angle,
        message: `Hi ${first}, regional sales leadership seems to require a difficult kind of visibility: enough detail to spot account risks, commitments, and changes across many teams, but not so much process that reps spend more time reporting than selling. ${credibilityLine(lead, "turning customer conversations into cleaner account context and next actions")} I would be curious whether that visibility gap becomes more pronounced at the regional level.`,
        withheld: false,
        reason: angle.fit,
      };
    }

    if (style === "Shared problem") {
      return {
        angle,
        message: `Hi ${first}, large sales teams seem to run into a recurring problem: the best customer intelligence is generated in live conversations, but only a thin version makes it back into CRM. That creates gaps in coaching, follow-through, account strategy, and manager visibility. ${credibilityLine(lead, "capturing customer context and next actions without turning sellers into data-entry staff")} Do you think leaders underestimate the post-meeting part of sales execution?`,
        withheld: false,
        reason: angle.fit,
      };
    }

    if (style === "Challenge conventional thinking") {
      return {
        angle,
        message: `Hi ${first}, I am becoming convinced that many sales organizations do not have an effort problem as much as a context problem. Reps may be active, but the risks, commitments, decision signals, and customer changes behind that activity often stay buried in scattered notes or memory. ${credibilityLine(lead, "turning conversations into accurate CRM updates and next actions with less administrative drag")} Does that show up more as a productivity issue or a visibility issue from your seat?`,
        withheld: false,
        reason: angle.fit,
      };
    }

    return {
      angle,
      message: `Hi ${first}, one sales execution gap I keep seeing is the distance between what happens in customer conversations and what leadership can actually see later. Activity gets logged, but the context behind risks, commitments, objections, and next steps is often incomplete. ${credibilityLine(lead, "making customer intelligence visible without adding more process for reps")} I would be curious whether that gap becomes more painful as teams and account coverage get larger.`,
      withheld: false,
      reason: angle.fit,
    };
  }

  if (lowerTitle.includes("operations") || lowerTitle.includes("strategy")) {
    return {
      angle,
      message: `Hi ${first}, one operational problem I keep thinking about is how much execution risk begins with incomplete customer information. A commitment, concern, or change may come up in a sales conversation, but the teams responsible for delivery do not always get the context early enough. ${credibilityLine(lead, "turning those conversations into structured account intelligence and clearer handoffs")} From an operations perspective, how much friction begins with information that arrived late or incomplete?`,
      withheld: false,
      reason: angle.fit,
    };
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

async function postSlackMessage({ text, threadTs }) {
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

async function deliverToSlack({ auth, identity, since, leads, messagedLeadIds, seenLeadIds, eligibleQueue, readyQueue, manualReviewQueue, queue }) {
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

  const parent = await postSlackMessage({ text: summary });
  for (const [index, item] of queue.entries()) {
    await postSlackMessage({
      text: formatSlackLead(item, index, auth),
      threadTs: parent.ts,
    });
  }

  if (manualReviewQueue.length) {
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

  const reviewedQueue = eligibleQueue.map((item, index) => {
    const style = chooseConversationStyle(item.lead, item.classification.persona, offset + index);
    const personalization = personalizationProfile(item.lead, item.classification);
    const draft = draftMessage(item.lead, item.classification, style, personalization);
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
