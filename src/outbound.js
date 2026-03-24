// Outbound: Slack thread reply -> WhatsApp message (via Twilio)
const { WebClient } = require("@slack/web-api");
const twilio = require("twilio");
const crypto = require("crypto");
const db = require("./db");

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const SLACK_BOT_USER_ID = process.env.SLACK_BOT_USER_ID;

// Validate Slack request signature
function validateSlackRequest(req) {
  if (process.env.SKIP_SLACK_VALIDATION === "true") return true;

  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];

  if (!timestamp || !signature) return false;

  // Reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  const sigBasestring = `v0:${timestamp}:${req.rawBody}`;
  const mySignature =
    "v0=" +
    crypto.createHmac("sha256", SLACK_SIGNING_SECRET).update(sigBasestring).digest("hex");

  return crypto.timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature));
}

// Download a Slack file and return a publicly accessible URL for Twilio
// Twilio needs a public URL to send media, so we host it temporarily
async function getSlackFileUrl(fileInfo) {
  // Slack files need the bot token to access.
  // For Twilio to fetch the media, we need a public URL.
  // We'll use Slack's public URL if available, otherwise download and
  // serve temporarily via our own server.
  if (fileInfo.url_private_download) {
    // Return our proxy endpoint so Twilio can fetch it with auth
    const baseUrl = process.env.BASE_URL;
    return `${baseUrl}/media/slack/${fileInfo.id}`;
  }
  return null;
}

// Main handler for Slack Events API
async function handleSlackEvent(req, res) {
  try {
  const body = req.body;

  // Handle Slack URL verification challenge
  if (body.type === "url_verification") {
    return res.json({ challenge: body.challenge });
  }

  // Validate request signature
  if (!validateSlackRequest(req)) {
    console.warn("Invalid Slack signature, rejecting request");
    return res.status(403).send("Forbidden");
  }

  // Acknowledge immediately (Slack expects response within 3 seconds)
  res.status(200).send("ok");

  // Only process message events
  if (body.type !== "event_callback" || !body.event) return;

  const event = body.event;

  // Only handle messages (not subtypes like bot_message, file_share, etc.)
  // We want regular user messages and file_share messages
  if (event.type !== "message") return;

  // Skip bot messages to prevent loops
  if (event.bot_id || event.subtype === "bot_message") return;
  if (event.user === SLACK_BOT_USER_ID) return;

  // Only handle thread replies in our support channel
  if (event.channel !== SLACK_CHANNEL) return;
  if (!event.thread_ts) return; // Not a thread reply, skip

  // Look up which WhatsApp number this thread belongs to
  const conversation = await db.findByThread(event.channel, event.thread_ts);
  if (!conversation) {
    console.log(`No conversation found for thread ${event.thread_ts}, skipping`);
    return;
  }

  const phoneNumber = conversation.phone_number;
  const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

  console.log(`Outbound to ${phoneNumber}: "${event.text || "(media)"}"`);

  try {
    // Check for file attachments
    const files = event.files || [];
    const mediaUrls = [];

    for (const file of files) {
      const publicUrl = await getSlackFileUrl(file);
      if (publicUrl) {
        mediaUrls.push(publicUrl);
      }
    }

    if (mediaUrls.length > 0) {
      // Send each media file as a separate message (Twilio supports 1 media per WhatsApp message)
      for (let i = 0; i < mediaUrls.length; i++) {
        const msgParams = {
          from: TWILIO_WHATSAPP_NUMBER,
          to: `whatsapp:${phoneNumber}`,
          mediaUrl: [mediaUrls[i]],
        };
        // Attach text only to the first media message
        if (i === 0 && event.text) {
          msgParams.body = event.text;
        }
        await twilioClient.messages.create(msgParams);
      }
      // If there are more media than text, and text wasn't sent with first media
    } else if (event.text) {
      // Text-only message
      await twilioClient.messages.create({
        from: TWILIO_WHATSAPP_NUMBER,
        to: `whatsapp:${phoneNumber}`,
        body: event.text,
      });
    }

    await db.touch(phoneNumber);
    console.log(`Successfully sent message to ${phoneNumber}`);
  } catch (err) {
    console.error(`Failed to send WhatsApp message to ${phoneNumber}:`, err.message);

    // Notify in Slack thread that delivery failed
    await slack.chat.postMessage({
      channel: SLACK_CHANNEL,
      thread_ts: event.thread_ts,
      text: `:x: Failed to deliver message to WhatsApp: ${err.message}`,
    });
  }
  } catch (err) {
    console.error("Unhandled error in handleSlackEvent:", err);
  }
}

// Proxy endpoint: serves Slack files to Twilio (which needs a public URL)
async function handleMediaProxy(req, res) {
  const fileId = req.params.fileId;

  try {
    // Get file info from Slack
    const fileInfo = await slack.files.info({ file: fileId });
    const file = fileInfo.file;

    if (!file || !file.url_private_download) {
      return res.status(404).send("File not found");
    }

    // Download from Slack
    const response = await fetch(file.url_private_download, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });

    if (!response.ok) {
      return res.status(502).send("Failed to fetch file from Slack");
    }

    // Stream to the requester (Twilio)
    res.set("Content-Type", file.mimetype || "application/octet-stream");
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    console.error(`Media proxy error for file ${fileId}:`, err.message);
    res.status(500).send("Internal error");
  }
}

module.exports = { handleSlackEvent, handleMediaProxy };
