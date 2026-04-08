// Outbound: Slack thread reply -> WhatsApp message (via Twilio)
const { WebClient } = require("@slack/web-api");
const twilio = require("twilio");
const crypto = require("crypto");
const db = require("./db");
const { translate } = require("./translate");

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const SLACK_BOT_USER_ID = process.env.SLACK_BOT_USER_ID;

// Convert common Slack emoji codes to Unicode
const SLACK_EMOJI_MAP = {
  ":slightly_smiling_face:": "🙂",
  ":smile:": "😄",
  ":grinning:": "😀",
  ":laughing:": "😆",
  ":sweat_smile:": "😅",
  ":joy:": "😂",
  ":wink:": "😉",
  ":blush:": "😊",
  ":heart_eyes:": "😍",
  ":sunglasses:": "😎",
  ":thumbsup:": "👍",
  ":thumbsdown:": "👎",
  ":ok_hand:": "👌",
  ":pray:": "🙏",
  ":clap:": "👏",
  ":wave:": "👋",
  ":point_right:": "👉",
  ":white_check_mark:": "✅",
  ":x:": "❌",
  ":warning:": "⚠️",
  ":question:": "❓",
  ":exclamation:": "❗",
  ":fire:": "🔥",
  ":wrench:": "🔧",
  ":hammer:": "🔨",
  ":construction:": "🚧",
  ":checkered_flag:": "🏁",
  ":phone:": "📞",
  ":email:": "📧",
  ":calendar:": "📅",
  ":clock1:": "🕐",
  ":thinking_face:": "🤔",
  ":disappointed:": "😞",
  ":worried:": "😟",
  ":cry:": "😢",
  ":angry:": "😠",
};

function convertSlackEmojis(text) {
  return text.replace(/:[a-z0-9_]+:/g, (match) => SLACK_EMOJI_MAP[match] || match);
}

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

// In-memory cache for pre-downloaded Slack files (served to Twilio)
// Entries auto-expire after 5 minutes
const mediaCache = new Map();
const MEDIA_CACHE_TTL = 5 * 60 * 1000;

// Pre-download a Slack file and return a public URL that serves it from cache
async function prepareSlackFileForTwilio(fileInfo) {
  const downloadUrl = fileInfo.url_private_download || fileInfo.url_private;
  if (!downloadUrl) return null;

  try {
    const response = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });
    if (!response.ok) {
      console.error(`Failed to pre-download Slack file ${fileInfo.id}: ${response.status}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = fileInfo.mimetype || "application/octet-stream";
    const filename = fileInfo.name || `file.${fileInfo.filetype || "bin"}`;

    // Store in cache
    mediaCache.set(fileInfo.id, { buffer, contentType, filename });
    setTimeout(() => mediaCache.delete(fileInfo.id), MEDIA_CACHE_TTL);

    const baseUrl = process.env.BASE_URL;
    return `${baseUrl}/media/slack/${fileInfo.id}/${encodeURIComponent(filename)}`;
  } catch (err) {
    console.error(`Failed to pre-download Slack file ${fileInfo.id}:`, err.message);
    return null;
  }
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
  const targetLang = conversation.detected_language;

  // Look up the Slack user's display name
  let agentName = null;
  try {
    const userInfo = await slack.users.info({ user: event.user });
    const profile = userInfo.user?.profile;
    agentName =
      profile?.display_name ||
      profile?.real_name ||
      userInfo.user?.real_name ||
      userInfo.user?.name ||
      null;
    console.log(`Slack user lookup for ${event.user}: display_name="${profile?.display_name}" real_name="${profile?.real_name}" name="${userInfo.user?.name}" -> using "${agentName}"`);
  } catch (err) {
    console.error("Failed to fetch Slack user info:", err.message);
  }

  console.log(`Outbound to ${phoneNumber}: "${event.text || "(media)"}" (lang: ${targetLang || "EN"}, agent: ${agentName})`);

  // Translate outbound text to mechanic's language if known and not English
  let outboundText = convertSlackEmojis(event.text || "");
  if (outboundText && targetLang && targetLang !== "EN") {
    try {
      const result = await translate(outboundText, targetLang, "EN");
      outboundText = result.text;
    } catch (err) {
      console.error("Translation error (outbound):", err.message);
      // Fall back to original English text
    }
  }

  // Prepend agent name so mechanic knows who they're speaking to
  if (agentName && outboundText) {
    outboundText = `*${agentName}:* ${outboundText}`;
  }

  try {
    // Check for file attachments
    const files = event.files || [];
    const mediaUrls = [];

    for (const file of files) {
      console.log(`Slack file: id=${file.id} name=${file.name} mimetype=${file.mimetype} url_private=${file.url_private ? "yes" : "no"} url_private_download=${file.url_private_download ? "yes" : "no"}`);
      const publicUrl = await prepareSlackFileForTwilio(file);
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
        if (i === 0 && outboundText) {
          msgParams.body = outboundText;
        }
        console.log(`Sending media to Twilio: ${JSON.stringify(msgParams)}`);
        await twilioClient.messages.create(msgParams);
      }
    } else if (outboundText) {
      // Text-only message
      await twilioClient.messages.create({
        from: TWILIO_WHATSAPP_NUMBER,
        to: `whatsapp:${phoneNumber}`,
        body: outboundText,
      });
    }

    await db.touch(phoneNumber);
    await db.logMessage(phoneNumber, conversation.display_name, "outbound", event.text || null, targetLang);
    console.log(`Successfully sent message to ${phoneNumber}`);
  } catch (err) {
    console.error(`Failed to send WhatsApp message to ${phoneNumber}:`, err.message, err.code, err.status, err.moreInfo);

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

// Proxy endpoint: serves pre-cached Slack files to Twilio
function handleMediaProxy(req, res) {
  const fileId = req.params.fileId;
  const cached = mediaCache.get(fileId);

  if (!cached) {
    console.error(`Media cache miss for file ${fileId} — file expired or was never cached`);
    return res.status(404).send("File not found or expired");
  }

  res.set("Content-Type", cached.contentType);
  res.set("Content-Disposition", `inline; filename="${cached.filename}"`);
  res.send(cached.buffer);
}

module.exports = { handleSlackEvent, handleMediaProxy };
