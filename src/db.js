const fs = require("fs");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "conversations.json");

let data = null;

function load() {
  if (data) return data;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (fs.existsSync(DB_PATH)) {
    data = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  } else {
    data = { conversations: {} };
  }
  return data;
}

function save() {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Find a conversation by phone number
function findByPhone(phoneNumber) {
  const d = load();
  return d.conversations[phoneNumber] || null;
}

// Find a conversation by Slack thread
function findByThread(channel, threadTs) {
  const d = load();
  for (const [phone, conv] of Object.entries(d.conversations)) {
    if (conv.slack_channel === channel && conv.slack_thread_ts === threadTs) {
      return { phone_number: phone, ...conv };
    }
  }
  return null;
}

// Create or update a conversation
function upsert(phoneNumber, slackChannel, slackThreadTs, displayName) {
  const d = load();
  const existing = d.conversations[phoneNumber];
  d.conversations[phoneNumber] = {
    slack_thread_ts: slackThreadTs,
    slack_channel: slackChannel,
    display_name: displayName || (existing && existing.display_name) || null,
    first_contact_at: (existing && existing.first_contact_at) || new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  };
  save();
}

// Update last_message_at timestamp
function touch(phoneNumber) {
  const d = load();
  if (d.conversations[phoneNumber]) {
    d.conversations[phoneNumber].last_message_at = new Date().toISOString();
    save();
  }
}

module.exports = { findByPhone, findByThread, upsert, touch };
