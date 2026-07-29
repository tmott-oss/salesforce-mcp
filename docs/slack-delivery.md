# Slack Bot Delivery

Use Slack delivery when you want the daily Sales Navigator queue posted to a team channel instead of only printed in Terminal.

## Recommended Slack App Setup

1. Go to `api.slack.com/apps`.
2. Create a new app from scratch.
3. Choose the workspace.
4. Go to **OAuth & Permissions**.
5. Add this bot token scope:

```text
chat:write
```

6. Install the app to the workspace.
7. Copy the **Bot User OAuth Token**. It starts with `xoxb-`.
8. Invite the bot to the target channel.

```text
/invite @your-bot-name
```

9. Copy the Slack channel ID.

The channel ID usually starts with `C` for public channels or `G` for private channels.

## Local Env

Add these to `.env`:

```env
SLACK_BOT_TOKEN=xoxb-your-slack-bot-token
SLACK_CHANNEL_ID=C0123456789
SLACK_MANUAL_REVIEW_LIMIT=10
```

Never commit `.env`.

## Run Slack Delivery

```bash
npm run daily-outreach -- --limit=8 --deliver=slack
```

To post and then skip this batch next time:

```bash
npm run daily-outreach -- --limit=8 --deliver=slack --remember
```

If Slack posting fails, the script stops before saving the local seen list. That way a batch is not accidentally marked complete when it never reached the channel.

## Slack Format

The script posts:

- One parent summary message in the configured channel.
- One threaded reply per ready-for-review lead.
- A final threaded manual-review summary for Low-confidence leads.

Each ready lead includes:

- Name, title, and company
- Fit score, persona, and confidence
- Recommended problem angle
- Prior LinkedIn steps
- Salesforce link
- Sales Navigator link when available
- Pre-written LinkedIn message

## Troubleshooting

- `Slack delivery requires SLACK_BOT_TOKEN and SLACK_CHANNEL_ID`: add both values to `.env`.
- `Slack post failed: not_in_channel`: invite the bot to the target channel.
- `Slack post failed: channel_not_found`: check the channel ID.
- `Slack post failed: invalid_auth`: regenerate or reinstall the bot token.
- `Slack post failed: missing_scope`: add `chat:write`, reinstall the app, and update `.env` if the token changed.

