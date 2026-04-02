// Inbound: WhatsApp message (via Twilio webhook) -> Slack
const { WebClient } = require("@slack/web-api");
const twilio = require("twilio");
const db = require("./db");

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER; // e.g. "whatsapp:+14405863762"

// Business hours: Mon-Fri 08:00-18:00 Europe/Zurich
const BUSINESS_START = 8;
const BUSINESS_END = 18;

function getEstimatedResponseMessage() {
  const now = new Date();
  const zurich = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Zurich" }));
  const day = zurich.getDay(); // 0=Sun, 6=Sat
  const hour = zurich.getHours();
  const isWeekday = day >= 1 && day <= 5;
  const isBusinessHours = hour >= BUSINESS_START && hour < BUSINESS_END;

  if (isWeekday && isBusinessHours) {
    return "✅ Your message reached FALU support. We'll get back to you within 30 minutes.";
  }

  // Calculate hours until next business day start
  const next = new Date(zurich);
  next.setHours(BUSINESS_START, 0, 0, 0);

  if (isWeekday && hour >= BUSINESS_END) {
    next.setDate(next.getDate() + 1);
  }

  const nextDay = next.getDay();
  if (nextDay === 6) next.setDate(next.getDate() + 2);
  else if (nextDay === 0) next.setDate(next.getDate() + 1);

  const hoursUntil = Math.round((next - zurich) / (1000 * 60 * 60));

  return `✅ Your message reached FALU support. Our team is based in Switzerland and is currently offline. We will reply in about ${hoursUntil} hours.`;
}

// Validate that the request really comes from Twilio
function validateTwilioRequest(req) {
  if (process.env.SKIP_TWILIO_VALIDATION === "true") return true;
  const baseUrl = process.env.BASE_URL;
  if (!baseUrl) {
    console.warn("BASE_URL not set, skipping Twilio validation");
    return true;
  }
  const signature = req.headers["x-twilio-signature"] || "";
  const url = baseUrl + "/webhook/twilio";
  return twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body);
}

// Clean phone number: "whatsapp:+14405863762" -> "+14405863762"
function cleanPhone(raw) {
  return raw.replace("whatsapp:", "").trim();
}

// Format phone for display: "+14405863762" -> "(440) 586-3762"
function formatPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "1") {
    const area = digits.slice(1, 4);
    const mid = digits.slice(4, 7);
    const last = digits.slice(7);
    return `(${area}) ${mid}-${last}`;
  }
  return phone;
}

// Download media from Twilio and upload to Slack
async function uploadMediaToSlack(mediaUrl, mediaContentType, threadTs) {
  // Fetch media from Twilio (requires auth)
  const response = await fetch(mediaUrl, {
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64"),
    },
  });

  if (!response.ok) {
    console.error(`Failed to fetch media: ${response.status} ${response.statusText}`);
    return null;
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  // Determine file extension from content type
  const extMap = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/3gpp": "3gp",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "application/pdf": "pdf",
  };
  const ext = extMap[mediaContentType] || "bin";
  const filename = `whatsapp-media-${Date.now()}.${ext}`;

  // Upload to Slack
  const uploadResult = await slack.filesUploadV2({
    channel_id: SLACK_CHANNEL,
    thread_ts: threadTs,
    file: buffer,
    filename,
  });

  return uploadResult;
}

// Main handler for incoming WhatsApp messages
async function handleInbound(req, res) {
  try {
  // Validate Twilio signature
  if (!validateTwilioRequest(req)) {
    console.warn("Invalid Twilio signature, rejecting request");
    return res.status(403).send("Forbidden");
  }

  const body = req.body;
  const from = cleanPhone(body.From || "");
  const messageBody = body.Body || "";
  const numMedia = parseInt(body.NumMedia || "0", 10);
  const profileName = body.ProfileName || null;

  console.log(`Inbound WhatsApp from ${from}: "${messageBody}" (${numMedia} media)`);

  // Look up existing conversation (expire after 12 hours of inactivity)
  const existing = await db.findByPhone(from);
  const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
  const isExpired = existing && (Date.now() - new Date(existing.last_message_at).getTime() > TWELVE_HOURS_MS);
  const isNewConversation = !existing || isExpired;

  let threadTs;

  if (existing) {
    // Post as thread reply to existing conversation
    const slackMsg = await slack.chat.postMessage({
      channel: SLACK_CHANNEL,
      thread_ts: existing.slack_thread_ts,
      text: messageBody || "(media message)",
      unfurl_links: false,
    });
    threadTs = existing.slack_thread_ts;
    await db.touch(from);
  } else {
    // Start a new thread in Slack
    const displayName = profileName || formatPhone(from);
    const headerText = `:iphone: *New WhatsApp message from ${displayName}*\nPhone: \`${from}\``;

    const slackMsg = await slack.chat.postMessage({
      channel: SLACK_CHANNEL,
      text: headerText,
      unfurl_links: false,
    });
    threadTs = slackMsg.ts;

    // If there's a text body, post it as the first thread reply
    if (messageBody) {
      await slack.chat.postMessage({
        channel: SLACK_CHANNEL,
        thread_ts: threadTs,
        text: messageBody,
        unfurl_links: false,
      });
    }

    // Save the conversation mapping
    await db.upsert(from, SLACK_CHANNEL, threadTs, displayName);
  }

  // Handle media attachments
  for (let i = 0; i < numMedia; i++) {
    const mediaUrl = body[`MediaUrl${i}`];
    const mediaContentType = body[`MediaContentType${i}`];
    if (mediaUrl) {
      try {
        await uploadMediaToSlack(mediaUrl, mediaContentType, threadTs);
      } catch (err) {
        console.error(`Failed to upload media ${i}:`, err.message);
        await slack.chat.postMessage({
          channel: SLACK_CHANNEL,
          thread_ts: threadTs,
          text: `:warning: Failed to load media attachment (${mediaContentType})`,
        });
      }
    }
  }

  // Send auto-reply to first-time senders
  if (isNewConversation) {
    try {
      const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
      await twilioClient.messages.create({
        from: TWILIO_WHATSAPP_NUMBER,
        to: `whatsapp:${from}`,
        body: getEstimatedResponseMessage(),
      });
      console.log(`Sent auto-reply to ${from}`);
    } catch (err) {
      console.error("Failed to send auto-reply:", err.message);
    }
  }

  // Respond to Twilio (empty TwiML - no immediate reply)
  res.type("text/xml").send("<Response></Response>");
  } catch (err) {
    console.error("Unhandled error in handleInbound:", err);
    res.status(500).type("text/xml").send("<Response></Response>");
  }
}

module.exports = { handleInbound };
