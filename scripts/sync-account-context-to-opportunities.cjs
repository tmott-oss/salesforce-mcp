#!/usr/bin/env node

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const jsforce = require("jsforce");

const DEFAULT_SINCE = "2025-01-01";
const SOURCE_MARKER = "SF_ACCOUNT_CONTEXT_SYNC_SOURCE";
const GENERATED_MARKER = "Synced from Account to Opportunity by salesforce-mcp";

function parseArgs(argv) {
  const args = {
    execute: false,
    since: DEFAULT_SINCE,
    limit: 100,
    opportunityId: null,
    includeClosed: false,
    includeAmbiguousAccounts: false,
    json: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") args.execute = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--include-closed") args.includeClosed = true;
    else if (arg === "--include-ambiguous-accounts") args.includeAmbiguousAccounts = true;
    else if (arg === "--since") args.since = argv[++index];
    else if (arg.startsWith("--since=")) args.since = arg.slice("--since=".length);
    else if (arg === "--limit") args.limit = Number(argv[++index]);
    else if (arg.startsWith("--limit=")) args.limit = Number(arg.slice("--limit=".length));
    else if (arg === "--opportunity-id") args.opportunityId = argv[++index];
    else if (arg.startsWith("--opportunity-id=")) args.opportunityId = arg.slice("--opportunity-id=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.since)) throw new Error("--since must be YYYY-MM-DD");
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error("--limit must be a positive integer");
  return args;
}

function loadConnection() {
  const tokenPath = process.env.SF_TOKEN_PATH || path.join(process.cwd(), ".sf-auth.json");
  const auth = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
  return new jsforce.Connection({
    instanceUrl: auth.instanceUrl,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    oauth2: {
      loginUrl: process.env.SF_LOGIN_URL || "https://login.salesforce.com",
      clientId: process.env.SF_CLIENT_ID || auth.clientId || "",
    },
  });
}

function soql(value) {
  return String(value).replace(/'/g, "\\'");
}

function inList(values) {
  return values.map((value) => `'${soql(value)}'`).join(",");
}

function clean(value) {
  return value == null ? "" : String(value).replace(/\s+/g, " ").trim();
}

function isMeetingSummaryLike(record) {
  const text = `${record.Subject || ""} ${record.Title || ""} ${record.Description || ""} ${record.Body || ""}`.toLowerCase();
  return /\b(summary|executive summary|meeting summary|call summary|recap|key points|tl;?dr|action items?|next steps?|conversation summary|meeting overview|call overview)\b/.test(text);
}

function isSalesforceEmailTask(record) {
  return /^email:/i.test(clean(record.Subject));
}

function day(value) {
  return value ? String(value).slice(0, 10) : "";
}

function keyPart(value) {
  return clean(value).toLowerCase();
}

function naturalKeyForSource(source) {
  if (source.type === "EmailMessage") return `email:${keyPart(source.subject)}:${day(source.date)}`;
  if (source.type === "EnhancedNoteLink") return `content-document:${source.id}`;
  return `note:${keyPart(source.subject)}:${day(source.date)}`;
}

function sourceMarker(sourceId) {
  return `${SOURCE_MARKER}=${sourceId}`;
}

function appendMarker(body, source) {
  const details = [
    "",
    "---",
    GENERATED_MARKER,
    `${SOURCE_MARKER}=${source.id}`,
    `Source Type: ${source.type}`,
    `Source Parent Account: ${source.accountId}`,
    source.date ? `Source Date: ${source.date}` : null,
  ].filter(Boolean);
  return `${body || ""}${details.join("\n")}`;
}

function dateToDatetime(date) {
  return `${date}T00:00:00Z`;
}

async function queryAll(conn, query) {
  const result = await conn.query(query);
  let records = result.records || [];
  let nextUrl = result.nextRecordsUrl;
  while (nextUrl) {
    const next = await conn.queryMore(nextUrl);
    records = records.concat(next.records || []);
    nextUrl = next.nextRecordsUrl;
  }
  return records;
}

async function getOpportunities(conn, args, userId) {
  const fields = "Id, Name, AccountId, Account.Name, StageName, IsClosed, CloseDate, OwnerId, Owner.Name";
  if (args.opportunityId) {
    return queryAll(conn, `SELECT ${fields} FROM Opportunity WHERE Id = '${soql(args.opportunityId)}' LIMIT 1`);
  }

  const clauses = [`OwnerId = '${soql(userId)}'`];
  if (!args.includeClosed) clauses.push("IsClosed = false");
  return queryAll(
    conn,
    `SELECT ${fields} FROM Opportunity WHERE ${clauses.join(" AND ")} ORDER BY CloseDate ASC NULLS LAST, LastModifiedDate DESC LIMIT ${args.limit}`,
  );
}

async function getAccountSources(conn, accountIds, since) {
  if (!accountIds.length) return [];

  const ids = inList(accountIds);
  const sinceDt = dateToDatetime(since);
  const sources = [];

  const emails = await queryAll(
    conn,
    `SELECT Id, RelatedToId, Subject, TextBody, HtmlBody, MessageDate, FromName, FromAddress, ToAddress, CcAddress, BccAddress, Incoming, Status, LastModifiedDate
     FROM EmailMessage
     WHERE RelatedToId IN (${ids})
       AND (MessageDate >= ${sinceDt} OR LastModifiedDate >= ${sinceDt})
     ORDER BY MessageDate DESC NULLS LAST, LastModifiedDate DESC
     LIMIT 2000`,
  );
  for (const email of emails) {
    sources.push({
      type: "EmailMessage",
      id: email.Id,
      accountId: email.RelatedToId,
      date: email.MessageDate || email.LastModifiedDate,
      subject: clean(email.Subject) || "(no subject)",
      record: email,
      targetCategory: "Emails",
    });
  }

  const classicNotes = await queryAll(
    conn,
    `SELECT Id, ParentId, Title, Body, CreatedDate, LastModifiedDate
     FROM Note
     WHERE ParentId IN (${ids})
       AND (CreatedDate >= ${sinceDt} OR LastModifiedDate >= ${sinceDt})
     ORDER BY LastModifiedDate DESC
     LIMIT 2000`,
  );
  for (const note of classicNotes) {
    sources.push({
      type: "Note",
      id: note.Id,
      accountId: note.ParentId,
      date: note.CreatedDate || note.LastModifiedDate,
      subject: clean(note.Title) || "(untitled note)",
      record: note,
      targetCategory: "Notes",
    });
  }

  const meetingTasks = await queryAll(
    conn,
    `SELECT Id, WhatId, Subject, Description, ActivityDate, CreatedDate, LastModifiedDate, OwnerId
     FROM Task
     WHERE WhatId IN (${ids})
       AND (ActivityDate >= ${since} OR CreatedDate >= ${sinceDt} OR LastModifiedDate >= ${sinceDt})
     ORDER BY ActivityDate DESC NULLS LAST, LastModifiedDate DESC
     LIMIT 2000`,
  );
  for (const task of meetingTasks.filter((record) => !isSalesforceEmailTask(record) && isMeetingSummaryLike(record))) {
    sources.push({
      type: "TaskMeetingSummary",
      id: task.Id,
      accountId: task.WhatId,
      date: task.ActivityDate || task.CreatedDate || task.LastModifiedDate,
      subject: clean(task.Subject) || "(meeting summary)",
      record: task,
      targetCategory: "Notes",
    });
  }

  const meetingEvents = await queryAll(
    conn,
    `SELECT Id, WhatId, Subject, Description, StartDateTime, EndDateTime, CreatedDate, LastModifiedDate, OwnerId
     FROM Event
     WHERE WhatId IN (${ids})
       AND (StartDateTime >= ${sinceDt} OR CreatedDate >= ${sinceDt} OR LastModifiedDate >= ${sinceDt})
     ORDER BY StartDateTime DESC NULLS LAST, LastModifiedDate DESC
     LIMIT 2000`,
  );
  for (const event of meetingEvents.filter(isMeetingSummaryLike)) {
    sources.push({
      type: "EventMeetingSummary",
      id: event.Id,
      accountId: event.WhatId,
      date: event.StartDateTime || event.CreatedDate || event.LastModifiedDate,
      subject: clean(event.Subject) || "(meeting summary)",
      record: event,
      targetCategory: "Notes",
    });
  }

  const links = await queryAll(
    conn,
    `SELECT Id, LinkedEntityId, ContentDocumentId, ContentDocument.Title, ContentDocument.FileType, ContentDocument.LastModifiedDate
     FROM ContentDocumentLink
     WHERE LinkedEntityId IN (${ids})
       AND ContentDocument.FileType = 'SNOTE'
     ORDER BY ContentDocument.LastModifiedDate DESC
     LIMIT 2000`,
  );
  for (const link of links) {
    sources.push({
      type: "EnhancedNoteLink",
      id: link.ContentDocumentId,
      linkId: link.Id,
      accountId: link.LinkedEntityId,
      date: link.ContentDocument?.LastModifiedDate,
      subject: clean(link.ContentDocument?.Title) || "(enhanced note)",
      record: link,
      targetCategory: "Notes",
    });
  }

  return sources;
}

async function getExistingRecords(conn, opportunityIds) {
  const markersByOpportunity = new Map(opportunityIds.map((id) => [id, new Set()]));
  const naturalKeysByOpportunity = new Map(opportunityIds.map((id) => [id, new Set()]));
  if (!opportunityIds.length) return { markersByOpportunity, naturalKeysByOpportunity };

  const ids = inList(opportunityIds);
  const [emails, notes, tasks, documentLinks] = await Promise.all([
    queryAll(conn, `SELECT Id, RelatedToId, Subject, TextBody, HtmlBody, MessageDate FROM EmailMessage WHERE RelatedToId IN (${ids}) ORDER BY LastModifiedDate DESC LIMIT 2000`),
    queryAll(conn, `SELECT Id, ParentId, Title, Body, CreatedDate FROM Note WHERE ParentId IN (${ids}) ORDER BY LastModifiedDate DESC LIMIT 2000`),
    queryAll(conn, `SELECT Id, WhatId, Subject, Description, ActivityDate, CreatedDate FROM Task WHERE WhatId IN (${ids}) ORDER BY LastModifiedDate DESC LIMIT 2000`),
    queryAll(conn, `SELECT Id, LinkedEntityId, ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId IN (${ids}) LIMIT 2000`),
  ]);

  function collect(parentId, text) {
    const markerSet = markersByOpportunity.get(parentId);
    if (!markerSet || !text) return;
    const regex = new RegExp(`${SOURCE_MARKER}=([a-zA-Z0-9]{15,18})`, "g");
    let match;
    while ((match = regex.exec(String(text)))) markerSet.add(match[1]);
  }

  for (const email of emails) collect(email.RelatedToId, `${email.TextBody || ""}\n${email.HtmlBody || ""}`);
  for (const note of notes) collect(note.ParentId, note.Body);
  for (const task of tasks) collect(task.WhatId, task.Description);
  for (const link of documentLinks) markersByOpportunity.get(link.LinkedEntityId)?.add(link.ContentDocumentId);

  for (const email of emails) {
    naturalKeysByOpportunity.get(email.RelatedToId)?.add(`email:${keyPart(email.Subject)}:${day(email.MessageDate)}`);
  }
  for (const note of notes) {
    naturalKeysByOpportunity.get(note.ParentId)?.add(`note:${keyPart(note.Title)}:${day(note.CreatedDate)}`);
  }
  for (const task of tasks.filter((record) => !isSalesforceEmailTask(record) && isMeetingSummaryLike(record))) {
    naturalKeysByOpportunity.get(task.WhatId)?.add(`note:${keyPart(task.Subject)}:${day(task.ActivityDate || task.CreatedDate)}`);
  }
  for (const link of documentLinks) {
    naturalKeysByOpportunity.get(link.LinkedEntityId)?.add(`content-document:${link.ContentDocumentId}`);
  }

  return { markersByOpportunity, naturalKeysByOpportunity };
}

function createPlan(opportunities, sources, existingRecords, args) {
  const oppsByAccount = new Map();
  for (const opportunity of opportunities) {
    if (!opportunity.AccountId) continue;
    if (!oppsByAccount.has(opportunity.AccountId)) oppsByAccount.set(opportunity.AccountId, []);
    oppsByAccount.get(opportunity.AccountId).push(opportunity);
  }

  const plans = [];
  const skipped = [];

  for (const source of sources) {
    const accountOpportunities = oppsByAccount.get(source.accountId) || [];
    if (!accountOpportunities.length) continue;
    if (accountOpportunities.length > 1 && !args.includeAmbiguousAccounts && !args.opportunityId) {
      skipped.push({
        reason: "Multiple matching opportunities for account; rerun with --opportunity-id or --include-ambiguous-accounts.",
        source,
        opportunities: accountOpportunities.map((opportunity) => ({ id: opportunity.Id, name: opportunity.Name })),
      });
      continue;
    }

    for (const opportunity of accountOpportunities) {
      const markers = existingRecords.markersByOpportunity.get(opportunity.Id) || new Set();
      const naturalKeys = existingRecords.naturalKeysByOpportunity.get(opportunity.Id) || new Set();
      if (markers.has(source.id)) {
        skipped.push({
          reason: "Already synced to this opportunity.",
          source,
          opportunity: { id: opportunity.Id, name: opportunity.Name },
        });
        continue;
      }
      if (naturalKeys.has(naturalKeyForSource(source))) {
        skipped.push({
          reason: "Matching record already exists on this opportunity.",
          source,
          opportunity: { id: opportunity.Id, name: opportunity.Name },
        });
        continue;
      }

      plans.push({
        opportunity: {
          id: opportunity.Id,
          name: opportunity.Name,
          accountId: opportunity.AccountId,
          accountName: opportunity.Account?.Name,
        },
        source,
        action: buildAction(opportunity, source),
      });
    }
  }

  return { plans, skipped };
}

function buildAction(opportunity, source) {
  const sourceRecord = source.record;
  if (source.type === "EmailMessage") {
    const textBody = appendMarker(sourceRecord.TextBody || "", source);
    const htmlBody = sourceRecord.HtmlBody ? appendMarker(sourceRecord.HtmlBody, source) : undefined;
    return {
      object: "EmailMessage",
      category: "Emails",
      operation: "create",
      fields: {
        RelatedToId: opportunity.Id,
        Subject: sourceRecord.Subject || "(no subject)",
        TextBody: textBody || undefined,
        HtmlBody: htmlBody,
        FromName: sourceRecord.FromName || undefined,
        FromAddress: sourceRecord.FromAddress || undefined,
        ToAddress: sourceRecord.ToAddress || undefined,
        CcAddress: sourceRecord.CcAddress || undefined,
        BccAddress: sourceRecord.BccAddress || undefined,
        Incoming: sourceRecord.Incoming === true,
        Status: sourceRecord.Status || "3",
        MessageDate: sourceRecord.MessageDate || sourceRecord.LastModifiedDate || undefined,
      },
    };
  }

  if (source.type === "EnhancedNoteLink") {
    return {
      object: "ContentDocumentLink",
      category: "Notes",
      operation: "create",
      fields: {
        LinkedEntityId: opportunity.Id,
        ContentDocumentId: source.record.ContentDocumentId,
        ShareType: "V",
        Visibility: "AllUsers",
      },
    };
  }

  const body = source.type === "Note" ? sourceRecord.Body : sourceRecord.Description;
  return {
    object: "Note",
    category: "Notes",
    operation: "create",
    fields: {
      ParentId: opportunity.Id,
      Title: source.subject,
      Body: appendMarker(body || "", source),
    },
  };
}

async function executePlans(conn, plans) {
  const results = [];
  for (const plan of plans) {
    const result = await conn.sobject(plan.action.object).create(removeUndefined(plan.action.fields));
    results.push({
      sourceId: plan.source.id,
      sourceType: plan.source.type,
      opportunityId: plan.opportunity.id,
      object: plan.action.object,
      success: result.success,
      id: result.id,
      errors: result.errors,
    });
    if (!result.success) throw new Error(`Failed to create ${plan.action.object}: ${JSON.stringify(result.errors)}`);
  }
  return results;
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined && fieldValue !== ""));
}

function printablePlan(plan) {
  return {
    opportunity: plan.opportunity.name,
    account: plan.opportunity.accountName,
    sourceType: plan.source.type,
    sourceId: plan.source.id,
    sourceDate: plan.source.date,
    sourceSubject: plan.source.subject,
    targetRelatedCategory: plan.action.category,
    createObject: plan.action.object,
    operation: plan.action.operation,
  };
}

function printHuman(report) {
  console.log(`${report.execute ? "EXECUTE" : "DRY RUN"} Account-to-Opportunity context sync`);
  console.log(`Opportunities scanned: ${report.opportunityCount}`);
  console.log(`Account source records found: ${report.sourceCount}`);
  console.log(`Planned creates: ${report.plannedCreates}`);
  console.log(`Skipped: ${report.skippedCount}`);
  console.log("");

  const byOpportunity = new Map();
  for (const plan of report.plan) {
    if (!byOpportunity.has(plan.opportunity)) byOpportunity.set(plan.opportunity, []);
    byOpportunity.get(plan.opportunity).push(plan);
  }

  for (const [opportunity, plans] of byOpportunity) {
    console.log(`## ${opportunity}`);
    for (const plan of plans) {
      console.log(`- ${plan.targetRelatedCategory}: create ${plan.createObject} from ${plan.sourceType} ${plan.sourceDate || ""} "${plan.sourceSubject}"`);
    }
    console.log("");
  }

  if (report.skipped.length) {
    console.log("## Skipped");
    for (const skipped of report.skipped.slice(0, 25)) {
      console.log(`- ${skipped.reason} Source ${skipped.sourceType || skipped.source?.type || ""} ${skipped.sourceId || skipped.source?.id || ""} "${skipped.sourceSubject || skipped.source?.subject || ""}"`);
    }
    if (report.skipped.length > 25) console.log(`- ${report.skipped.length - 25} additional skipped records omitted from console output.`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const conn = loadConnection();
  const identity = await conn.identity();
  const opportunities = await getOpportunities(conn, args, identity.user_id);
  const accountIds = [...new Set(opportunities.map((opportunity) => opportunity.AccountId).filter(Boolean))];
  const sources = await getAccountSources(conn, accountIds, args.since);
  const existingRecords = await getExistingRecords(conn, opportunities.map((opportunity) => opportunity.Id));
  const { plans, skipped } = createPlan(opportunities, sources, existingRecords, args);

  const report = {
    generatedAt: new Date().toISOString(),
    execute: args.execute,
    since: args.since,
    opportunityCount: opportunities.length,
    sourceCount: sources.length,
    plannedCreates: plans.length,
    skippedCount: skipped.length,
    plan: plans.map(printablePlan),
    skipped: skipped.map((entry) => ({
      reason: entry.reason,
      sourceType: entry.source?.type,
      sourceId: entry.source?.id,
      sourceSubject: entry.source?.subject,
      opportunities: entry.opportunities,
      opportunity: entry.opportunity,
    })),
  };

  if (args.execute) {
    if (process.env.SF_ALLOW_WRITE !== "1") {
      throw new Error("Writes are disabled. Set SF_ALLOW_WRITE=1 and rerun with --execute.");
    }
    report.results = await executePlans(conn, plans);
  }

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
