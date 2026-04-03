const { createClient } = require("@supabase/supabase-js");

let supabase;

function getClient() {
  if (!supabase) {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return supabase;
}

// Find a conversation by phone number
async function findByPhone(phoneNumber) {
  const { data, error } = await getClient()
    .from("conversations")
    .select("*")
    .eq("phone_number", phoneNumber)
    .single();
  if (error && error.code !== "PGRST116") {
    console.error("DB findByPhone error:", JSON.stringify(error));
    throw error;
  }
  console.log(`DB findByPhone ${phoneNumber}: ${data ? "found" : "not found"}`);
  return data || null;
}

// Find a conversation by Slack thread
async function findByThread(channel, threadTs) {
  const { data, error } = await getClient()
    .from("conversations")
    .select("*")
    .eq("slack_channel", channel)
    .eq("slack_thread_ts", threadTs)
    .single();
  if (error && error.code !== "PGRST116") throw error;
  return data || null;
}

// Create or update a conversation
async function upsert(phoneNumber, slackChannel, slackThreadTs, displayName, detectedLanguage = null) {
  const now = new Date().toISOString();
  const { error } = await getClient()
    .from("conversations")
    .upsert({
      phone_number: phoneNumber,
      slack_channel: slackChannel,
      slack_thread_ts: slackThreadTs,
      display_name: displayName,
      last_message_at: now,
      first_contact_at: now,
      detected_language: detectedLanguage,
    }, { onConflict: "phone_number" });
  if (error) {
    console.error("DB upsert error:", JSON.stringify(error));
    throw error;
  }
  console.log(`DB upsert ok for ${phoneNumber} -> thread ${slackThreadTs}`);
}

// Update last_message_at timestamp (and optionally detected_language)
async function touch(phoneNumber, detectedLanguage = null) {
  const update = { last_message_at: new Date().toISOString() };
  if (detectedLanguage) update.detected_language = detectedLanguage;
  const { error } = await getClient()
    .from("conversations")
    .update(update)
    .eq("phone_number", phoneNumber);
  if (error) throw error;
}

// Log an individual message (inbound or outbound) for analytics
async function logMessage(phoneNumber, displayName, direction, body, language = null) {
  const { error } = await getClient()
    .from("messages")
    .insert({
      phone_number: phoneNumber,
      display_name: displayName,
      direction,
      body: body || null,
      language: language || null,
    });
  if (error) console.error("DB logMessage error:", JSON.stringify(error));
}

module.exports = { findByPhone, findByThread, upsert, touch, logMessage };
