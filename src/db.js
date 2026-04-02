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
async function upsert(phoneNumber, slackChannel, slackThreadTs, displayName) {
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
      created_at: now,
    }, { onConflict: "phone_number" });
  if (error) {
    console.error("DB upsert error:", JSON.stringify(error));
    throw error;
  }
  console.log(`DB upsert ok for ${phoneNumber} -> thread ${slackThreadTs}`);
}

// Update last_message_at timestamp
async function touch(phoneNumber) {
  const { error } = await getClient()
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("phone_number", phoneNumber);
  if (error) throw error;
}

module.exports = { findByPhone, findByThread, upsert, touch };
