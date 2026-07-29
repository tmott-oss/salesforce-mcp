const { App } = require("@slack/bolt");
const { spawn } = require("child_process");
require("dotenv").config();

const token = process.env.SLACK_BOT_TOKEN || "";
const appToken = process.env.SLACK_APP_TOKEN || "";

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

app.action("open_salesforce", async ({ ack }) => {
  await ack();
});

app.action("open_sales_nav", async ({ ack }) => {
  await ack();
});

app.action("outreach_mark_sent", async ({ ack, body, action, client }) => {
  await ack();
  const value = parseValue(action.value);
  await postThreadReply({
    client,
    body,
    text: `Marked *${value.leadName || "this lead"}* as sent in Slack by <@${body.user.id}>. Salesforce is not updated yet.`,
  });
});

app.action("outreach_needs_review", async ({ ack, body, action, client }) => {
  await ack();
  const value = parseValue(action.value);
  await postThreadReply({
    client,
    body,
    text: `Flagged *${value.leadName || "this lead"}* for manual review by <@${body.user.id}>. Salesforce is not updated yet.`,
  });
});

(async () => {
  await app.start();
  console.log("Slack outreach actions listener is running in Socket Mode.");
})();
