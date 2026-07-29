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

6. Go to **Socket Mode** and turn it on.
7. Create an app-level token with this scope:

```text
connections:write
```

8. Copy the app-level token. It starts with `xapp-`.
9. Go to **Interactivity & Shortcuts** and turn interactivity on.
10. Install or reinstall the app to the workspace.
11. Copy the **Bot User OAuth Token**. It starts with `xoxb-`.
12. Invite the bot to the target channel.

```text
/invite @your-bot-name
```

13. Copy the Slack channel ID.

The channel ID usually starts with `C` for public channels or `G` for private channels.

## Local Env

Add these to `.env`:

```env
SLACK_BOT_TOKEN=xoxb-your-slack-bot-token
SLACK_APP_TOKEN=xapp-your-slack-app-token-for-socket-mode
SLACK_CHANNEL_ID=C0123456789
SLACK_MANUAL_REVIEW_LIMIT=10
```

Never commit `.env`.

## Run Slack Delivery

```bash
npm run daily-outreach -- --limit=5 --deliver=slack
```

To post and then skip this batch next time:

```bash
npm run daily-outreach -- --limit=5 --deliver=slack --remember
```

If Slack posting fails, the script stops before saving the local seen list. That way a batch is not accidentally marked complete when it never reached the channel.

## Slack Format

The script posts:

- One parent summary message in the configured channel.
- One threaded reply per ready-for-review lead.
- A final threaded manual-review summary for Low-confidence leads.
- Buttons for opening Salesforce, opening Sales Navigator, marking sent, flagging review, and generating the next 5 leads.

Each ready lead includes:

- Name, title, and company
- Fit score, persona, and confidence
- Recommended problem angle
- Prior LinkedIn steps
- Salesforce link
- Sales Navigator link when available
- Pre-written LinkedIn message

## Button Listener

Buttons require a local listener process. Start this in a separate Terminal window before using the buttons:

```bash
npm run slack-actions
```

The listener uses Slack Socket Mode, so you do not need a public URL or ngrok.

Current button behavior:

- **Next 5:** posts the next batch of 5 leads to Slack.
- **Mark Sent:** acknowledges the lead as sent in the Slack thread.
- **Needs Review:** acknowledges the lead as needing manual review in the Slack thread.
- Salesforce is not updated by these buttons yet. That write-back can be added after the team agrees on the exact Salesforce fields/statuses.

## Troubleshooting

- `Slack delivery requires SLACK_BOT_TOKEN and SLACK_CHANNEL_ID`: add both values to `.env`.
- `Slack actions require SLACK_BOT_TOKEN and SLACK_APP_TOKEN`: add the Socket Mode app token to `.env`.
- `Slack post failed: not_in_channel`: invite the bot to the target channel.
- `Slack post failed: channel_not_found`: check the channel ID.
- `Slack post failed: invalid_auth`: regenerate or reinstall the bot token.
- `Slack post failed: missing_scope`: add `chat:write`, reinstall the app, and update `.env` if the token changed.
- Buttons do nothing: confirm `npm run slack-actions` is running and Socket Mode is enabled.
