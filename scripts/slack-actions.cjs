const { App } = require("@slack/bolt");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const jsforce = require("../node_modules/jsforce");
require("dotenv").config();

const token = process.env.SLACK_BOT_TOKEN || "";
const appToken = process.env.SLACK_APP_TOKEN || "";
const tokenPath = process.env.SF_TOKEN_PATH || path.join(process.cwd(), ".sf-auth.json");
const manualReviewField = "Manual_Profile_Review_Required__c";
let leadFieldNames = null;

if (!token || !appToken) {
  throw new Error("Slack actions require SLACK_BOT_TOKEN and SLACK_APP_TOKEN in .env.");
}

const app = new App({
  token,
  appToken,
  socketMode: true,
});

function parseValue(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function escapeSoql(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function requireSalesforceWrite() {
  if (process.env.SF_ALLOW_WRITE !== "1") {
    throw new Error("Salesforce write-back requires SF_ALLOW_WRITE=1 in .env.");
  }
}

function readAuth() {
  if (!fs.existsSync(tokenPath)) {
    throw new Error(`Salesforce auth file not found: ${tokenPath}`);
  }
  return JSON.parse(fs.readFileSync(tokenPath, "utf8"));
}

function getSalesforceConnection() {
  const auth = readAuth();
  return new jsforce.Connection({
    instanceUrl: auth.instanceUrl,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    oauth2: {
      loginUrl: process.env.SF_LOGIN_URL || auth.loginUrl || "https://login.salesforce.com",
      clientId: process.env.SF_CLIENT_ID || auth.clientId || "",
    },
  });
}

async function getLeadFieldNames(conn) {
  if (leadFieldNames) return leadFieldNames;
  const describe = await conn.sobject("Lead").describe();
  leadFieldNames = new Set(describe.fields.filter((field) => field.updateable).map((field) => field.name));
  return leadFieldNames;
}

async function updateLeadIfFieldsExist(conn, leadId, fields) {
  const availableFields = await getLeadFieldNames(conn);
  const update = { Id: leadId };
  for (const [field, value] of Object.entries(fields)) {
    if (availableFields.has(field)) update[field] = value;
  }
  if (Object.keys(update).length > 1) {
    await conn.sobject("Lead").update(update);
  }
  return Object.keys(update).filter((field) => field !== "Id");
}

async function markLeadMessageSent({ leadId, leadName, slackUserId }) {
  requireSalesforceWrite();
  const conn = getSalesforceConnection();
  const date = today();

  const existing = await conn.query(`
    SELECT Id
    FROM Task
    WHERE WhoId = '${escapeSoql(leadId)}'
      AND Subject = 'LinkedIn Step Message'
      AND Status = 'Completed'
      AND ActivityDate = ${date}
    LIMIT 1
  `);

  let taskId = existing.records[0]?.Id;
  if (!taskId) {
    const result = await conn.sobject("Task").create({
      WhoId: leadId,
      Subject: "LinkedIn Step Message",
      Status: "Completed",
      Type: "Other",
      ActivityDate: date,
      Description: `Marked sent from Slack outreach queue by Slack user ${slackUserId}.`,
    });
    if (!result.success) {
      throw new Error(`Could not create completed Task for ${leadName || leadId}.`);
    }
    taskId = result.id;
  }

  const updatedFields = await updateLeadIfFieldsExist(conn, leadId, {
    LinkedIn_Conversation_Stage__c: "Conversation Started",
    LinkedIn_Last_Touch_Date__c: date,
  });

  return { taskId, createdTask: !existing.records[0], updatedFields };
}

async function flagLeadNeedsReview({ leadId, leadName, slackUserId }) {
  requireSalesforceWrite();
  const conn = getSalesforceConnection();
  const date = today();

  const existing = await conn.query(`
    SELECT Id
    FROM Task
    WHERE WhoId = '${escapeSoql(leadId)}'
      AND Subject = 'Review Sales Navigator profile'
      AND Status != 'Completed'
    LIMIT 1
  `);

  let taskId = existing.records[0]?.Id;
  if (!taskId) {
    const result = await conn.sobject("Task").create({
      WhoId: leadId,
      Subject: "Review Sales Navigator profile",
      Status: "Not Started",
      Type: "Other",
      ActivityDate: date,
      Description: `Flagged for manual profile review from Slack outreach queue by Slack user ${slackUserId}.`,
    });
    if (!result.success) {
      throw new Error(`Could not create review Task for ${leadName || leadId}.`);
    }
    taskId = result.id;
  }

  const updatedFields = await updateLeadIfFieldsExist(conn, leadId, {
    [manualReviewField]: true,
  });

  return { taskId, createdTask: !existing.records[0], updatedFields };
}

async function flagLeadNeedsResearch({ leadId, leadName, salesNavUrl, slackUserId }) {
  requireSalesforceWrite();
  const conn = getSalesforceConnection();
  const date = today();

  const existing = await conn.query(`
    SELECT Id
    FROM Task
    WHERE WhoId = '${escapeSoql(leadId)}'
      AND Subject = 'Research Sales Navigator profile'
      AND Status != 'Completed'
    LIMIT 1
  `);

  let taskId = existing.records[0]?.Id;
  if (!taskId) {
    const researchChecklist = [
      `Flagged for Sales Navigator research from Slack outreach queue by Slack user ${slackUserId}.`,
      "",
      "Research checklist:",
      "- Recent LinkedIn posts, reposts, or comments.",
      "- Role-specific language they use about priorities, customers, teams, or operations.",
      "- Personal/professional hooks that are safe and relevant.",
      "- Evidence that the current draft should be changed or withheld.",
      "",
      "After review, paste useful notes into the Slack thread or Salesforce notes before regenerating the message.",
      salesNavUrl ? `Sales Navigator: ${salesNavUrl}` : "",
    ].filter(Boolean).join("\n");

    const result = await conn.sobject("Task").create({
      WhoId: leadId,
      Subject: "Research Sales Navigator profile",
      Status: "Not Started",
      Type: "Other",
      ActivityDate: date,
      Description: researchChecklist,
    });
    if (!result.success) {
      throw new Error(`Could not create research Task for ${leadName || leadId}.`);
    }
    taskId = result.id;
  }

  return { taskId, createdTask: !existing.records[0] };
}

function runDailyOutreach({ offset, limit }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/daily-outreach-queue.cjs",
        `--limit=${limit || 5}`,
        `--offset=${offset || 0}`,
        "--deliver=slack",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `daily-outreach exited with ${code}`));
    });
  });
}

function parseBatchRequest(text) {
  const normalized = String(text || "").toLowerCase();
  if (!/(next|new|generate|more|messages|leads|outreach)/.test(normalized)) return null;

  const limitMatch = normalized.match(/\b(\d{1,2})\b/);
  const limit = limitMatch ? Math.min(Number(limitMatch[1]), 10) : 5;
  const offsetMatch = normalized.match(/\boffset\s+(\d{1,3})\b/);
  const offset = offsetMatch ? Number(offsetMatch[1]) : 0;

  if (!/(next|new|generate|more)/.test(normalized) && !/messages|leads|outreach/.test(normalized)) {
    return null;
  }

  return { limit, offset };
}

async function postThreadReply({ client, body, text }) {
  const channel = body.channel?.id;
  const threadTs = body.message?.thread_ts || body.message?.ts;
  if (!channel || !threadTs) return;
  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text,
  });
}

app.action("outreach_next_batch", async ({ ack, body, action, client }) => {
  await ack();
  const value = parseValue(action.value);
  const offset = Number(value.offset || 0);
  const limit = Number(value.limit || 5);
  console.log(`Received outreach_next_batch action: offset=${offset}, limit=${limit}`);

  await postThreadReply({
    client,
    body,
    text: `Generating the next ${limit} outreach leads, starting at offset ${offset}...`,
  });

  try {
    await runDailyOutreach({ offset, limit });
  } catch (error) {
    await postThreadReply({
      client,
      body,
      text: `Could not generate the next batch: ${error.message}`,
    });
  }
});

app.message(async ({ message, client }) => {
  if (message.subtype || message.bot_id) return;
  const request = parseBatchRequest(message.text);
  if (!request) return;

  console.log(`Received Slack text batch request: offset=${request.offset}, limit=${request.limit}`);
  await client.chat.postMessage({
    channel: message.channel,
    thread_ts: message.thread_ts || message.ts,
    text: `Generating ${request.limit} outreach leads${request.offset ? ` from offset ${request.offset}` : ""}...`,
  });

  try {
    await runDailyOutreach(request);
  } catch (error) {
    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.thread_ts || message.ts,
      text: `Could not generate outreach leads: ${error.message}`,
    });
  }
});

app.action("open_salesforce", async ({ ack }) => {
  await ack();
});

app.action("open_sales_nav", async ({ ack }) => {
  await ack();
});

app.action("outreach_mark_sent", async ({ ack, body, action, client }) => {
  await ack();
  const value = parseValue(action.value);
  try {
    const result = await markLeadMessageSent({
      leadId: value.leadId,
      leadName: value.leadName,
      slackUserId: body.user.id,
    });
    await postThreadReply({
      client,
      body,
      text: `Marked *${value.leadName || "this lead"}* as sent in Salesforce by <@${body.user.id}>. ${result.createdTask ? "Created" : "Reused"} Task ${result.taskId}.`,
    });
  } catch (error) {
    await postThreadReply({
      client,
      body,
      text: `Could not mark *${value.leadName || "this lead"}* as sent: ${error.message}`,
    });
  }
});

app.action("outreach_needs_review", async ({ ack, body, action, client }) => {
  await ack();
  const value = parseValue(action.value);
  try {
    const result = await flagLeadNeedsReview({
      leadId: value.leadId,
      leadName: value.leadName,
      slackUserId: body.user.id,
    });
    const fieldNote = result.updatedFields.includes(manualReviewField)
      ? ` Also set ${manualReviewField}.`
      : "";
    await postThreadReply({
      client,
      body,
      text: `Flagged *${value.leadName || "this lead"}* for manual review in Salesforce by <@${body.user.id}>. ${result.createdTask ? "Created" : "Reused"} Task ${result.taskId}.${fieldNote}`,
    });
  } catch (error) {
    await postThreadReply({
      client,
      body,
      text: `Could not flag *${value.leadName || "this lead"}* for review: ${error.message}`,
    });
  }
});

app.action("outreach_needs_research", async ({ ack, body, action, client }) => {
  await ack();
  const value = parseValue(action.value);
  try {
    const result = await flagLeadNeedsResearch({
      leadId: value.leadId,
      leadName: value.leadName,
      salesNavUrl: value.salesNavUrl,
      slackUserId: body.user.id,
    });
    const salesNavLine = value.salesNavUrl ? `\nSales Nav: ${value.salesNavUrl}` : "";
    await postThreadReply({
      client,
      body,
      text: [
        `Marked *${value.leadName || "this lead"}* as needing Sales Navigator research by <@${body.user.id}>. ${result.createdTask ? "Created" : "Reused"} Task ${result.taskId}.`,
        "",
        "Research checklist:",
        "- Recent posts, reposts, or comments.",
        "- Role-specific language about priorities, customers, teams, or operations.",
        "- A safe personal/professional hook.",
        "- Whether the current draft should be changed or withheld.",
        "",
        "Paste useful notes in this thread, then ask Codex to regenerate the message.",
        salesNavLine,
      ].filter(Boolean).join("\n"),
    });
  } catch (error) {
    await postThreadReply({
      client,
      body,
      text: `Could not flag *${value.leadName || "this lead"}* for research: ${error.message}`,
    });
  }
});

(async () => {
  await app.start();
  console.log("Slack outreach actions listener is running in Socket Mode.");
})();
