# WhatsApp-Slack Messenger

Bridges WhatsApp messages (via Twilio) to a Slack channel so factory floor mechanics can reach the tech support team. Replies in Slack threads are sent back to the WhatsApp sender.

Supports text, images, and video in both directions.

## How It Works

1. Mechanic sends a WhatsApp message to the Twilio number
2. Twilio forwards it to this server via webhook
3. Server posts the message (+ media) to a Slack channel as a new thread (or reply in existing thread)
4. Tech team replies in the Slack thread
5. Server receives the Slack event and sends the reply back via Twilio WhatsApp

## Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2. Under **OAuth & Permissions**, add these Bot Token Scopes:
   - `chat:write`
   - `files:read`
   - `files:write`
3. Install the app to your workspace and copy the **Bot User OAuth Token** (`xoxb-...`)
4. Under **Basic Information**, copy the **Signing Secret**
5. Invite the bot to your support channel (`/invite @YourBotName`)
6. Under **Event Subscriptions**:
   - Enable events
   - Set the Request URL to `https://your-server.com/webhook/slack`
   - Subscribe to bot events: `message.channels` (or `message.groups` for private channels)

### 2. Configure Twilio

1. In your Twilio console, go to your WhatsApp-enabled phone number
2. Set the **"A message comes in"** webhook to: `https://your-server.com/webhook/twilio` (HTTP POST)

### 3. Deploy

```bash
# Copy and fill in environment variables
cp .env.example .env

# Install dependencies
npm install

# Run
npm start
```

### Finding Your Slack IDs

- **Channel ID**: Right-click the channel name in Slack > "View channel details" > the ID is at the bottom
- **Bot User ID**: Call `https://slack.com/api/auth.test` with your bot token, the `user_id` field is what you need

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BASE_URL` | Yes | Public URL of this server (e.g. `https://your-app.railway.app`) |
| `TWILIO_ACCOUNT_SID` | Yes | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio Auth Token |
| `TWILIO_WHATSAPP_NUMBER` | Yes | Twilio WhatsApp number (e.g. `whatsapp:+14405863762`) |
| `SLACK_BOT_TOKEN` | Yes | Slack Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Yes | Slack app Signing Secret |
| `SLACK_CHANNEL_ID` | Yes | Slack channel ID to post messages to |
| `SLACK_BOT_USER_ID` | Yes | Bot's user ID (to filter out its own messages) |
| `AUTO_REPLY_MESSAGE` | No | Auto-reply sent to first-time WhatsApp senders |
| `PORT` | No | Server port (default: 3000) |

## Deploy to Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app)

1. Connect your GitHub repo
2. Add all environment variables
3. Railway will auto-detect the Dockerfile and deploy
4. Use the generated Railway URL as your `BASE_URL`
