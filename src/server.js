const express = require("express");
const { handleInbound } = require("./inbound");
const { handleSlackEvent, handleMediaProxy } = require("./outbound");

// Trim all env vars to avoid stray newlines/spaces breaking URLs etc.
for (const key of Object.keys(process.env)) {
  if (typeof process.env[key] === "string") {
    process.env[key] = process.env[key].trim();
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Parse Slack events as JSON but keep raw body for signature verification
app.use("/webhook/slack", express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString();
  },
}));

// Parse Twilio webhooks as URL-encoded form data
app.use("/webhook/twilio", express.urlencoded({ extended: false }));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Inbound: Twilio webhook (WhatsApp -> Slack)
app.post("/webhook/twilio", handleInbound);

// Outbound: Slack Events API (Slack -> WhatsApp)
app.post("/webhook/slack", handleSlackEvent);

// Media proxy: serves Slack files to Twilio
// Filename in URL helps Twilio determine media type
app.get("/media/slack/:fileId/:filename", handleMediaProxy);
// Keep old route as fallback
app.get("/media/slack/:fileId", handleMediaProxy);

app.listen(PORT, () => {
  console.log(`WhatsApp-Slack Messenger running on port ${PORT}`);
  console.log(`  Twilio webhook:  POST /webhook/twilio`);
  console.log(`  Slack events:    POST /webhook/slack`);
  console.log(`  Media proxy:     GET  /media/slack/:fileId`);
  console.log(`  Health check:    GET  /health`);
  // Debug: log which env vars are set
  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_NUMBER", "BASE_URL"];
  required.forEach(k => console.log(`  ${k}: ${process.env[k] ? "set" : "MISSING"}`));
});
