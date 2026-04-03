// Inbound: WhatsApp message (via Twilio webhook) -> Slack
const { WebClient } = require("@slack/web-api");
const twilio = require("twilio");
const Holidays = require("date-holidays");
const db = require("./db");
const { translate } = require("./translate");

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER; // e.g. "whatsapp:+14405863762"

// Business hours: Mon-Fri 08:00-18:00 Europe/Zurich, excluding ZH public holidays
const BUSINESS_START = 8;
const BUSINESS_END = 18;
const hd = new Holidays("CH", "ZH");

function getHolidayName(date) {
  const result = hd.isHoliday(date);
  if (!result) return null;
  const entry = Array.isArray(result) ? result[0] : result;
  return entry.name || null;
}

function isBusinessDay(date) {
  const day = date.getDay();
  return day >= 1 && day <= 5 && !getHolidayName(date);
}

// Advance to next business day; returns { date, holidaysSkipped: string[] }
function advanceToNextBusinessDay(date) {
  const d = new Date(date);
  const holidaysSkipped = [];
  d.setDate(d.getDate() + 1);
  while (!isBusinessDay(d)) {
    const name = getHolidayName(d);
    if (name && !holidaysSkipped.includes(name)) holidaysSkipped.push(name);
    d.setDate(d.getDate() + 1);
  }
  return { date: d, holidaysSkipped };
}

function getEstimatedResponseMessage() {
  const now = new Date();
  const zurich = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Zurich" }));
  const hour = zurich.getHours();
  const todayHoliday = getHolidayName(zurich);
  const isOpenNow = isBusinessDay(zurich) && hour >= BUSINESS_START && hour < BUSINESS_END;

  if (isOpenNow) {
    return "✅ Your message reached FALU support. We'll get back to you within 30 minutes.";
  }

  // Find when we next open
  let next = new Date(zurich);
  next.setHours(BUSINESS_START, 0, 0, 0);
  let holidaysInPath = todayHoliday ? [todayHoliday] : [];

  if (!isBusinessDay(zurich) || hour >= BUSINESS_END) {
    const { date: nextDate, holidaysSkipped } = advanceToNextBusinessDay(zurich);
    next = nextDate;
    next.setHours(BUSINESS_START, 0, 0, 0);
    holidaysInPath = [...holidaysInPath, ...holidaysSkipped];
  }

  const hoursUntil = Math.round((next - zurich) / (1000 * 60 * 60));

  let message = `✅ Your message reached FALU support. Our team is based in Switzerland and is currently offline. We will reply in about ${hoursUntil} hours.`;

  if (holidaysInPath.length > 0) {
    const names = holidaysInPath.join(", ");
    message += ` (Please note: we are observing the following public holiday${holidaysInPath.length > 1 ? "s" : ""}: ${names}.)`;
  }

  return message;
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

  // Translate inbound message to English if needed
  let displayBody = messageBody;
  let detectedLanguage = existing?.detected_language || null;
  let translationNote = "";

  if (messageBody) {
    try {
      const result = await translate(messageBody, "EN");
      detectedLanguage = result.detectedLanguage;
      // Only show translation if the message isn't already in English
      if (detectedLanguage && detectedLanguage !== "EN") {
        displayBody = result.text;
        translationNote = `\n\n_🌐 ${detectedLanguage} original:_\n_"${messageBody}"_`;
      }
    } catch (err) {
      console.error("Translation error:", err.message);
    }
  }

  if (existing && !isExpired) {
    // Post as thread reply to existing conversation
    await slack.chat.postMessage({
      channel: SLACK_CHANNEL,
      thread_ts: existing.slack_thread_ts,
      text: (displayBody || "(media)") + translationNote,
      unfurl_links: false,
    });
    threadTs = existing.slack_thread_ts;
    await db.touch(from, detectedLanguage);
  } else {
    // Start a new thread in Slack
    const displayName = profileName || formatPhone(from);
    const headerText = `:iphone: *Message from ${displayName}*`;

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
        text: displayBody + translationNote,
        unfurl_links: false,
      });
    }

    // Save the conversation mapping including detected language
    await db.upsert(from, SLACK_CHANNEL, threadTs, displayName, detectedLanguage);
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
      let autoReply = getEstimatedResponseMessage();
      if (detectedLanguage && detectedLanguage !== "EN") {
        try {
          const translated = await translate(autoReply, detectedLanguage, "EN");
          autoReply = translated.text;
        } catch (err) {
          console.error("Auto-reply translation error:", err.message);
        }
      }
      await twilioClient.messages.create({
        from: TWILIO_WHATSAPP_NUMBER,
        to: `whatsapp:${from}`,
        body: autoReply,
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
