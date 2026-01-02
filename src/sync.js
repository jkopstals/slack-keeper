const { WebClient } = require('@slack/web-api');
const { createClient } = require('@supabase/supabase-js');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function getLastSyncTime(channelId) {
  const { data, error } = await supabase
    .from('messages')
    .select('timestamp')
    .eq('channel_id', channelId)
    .order('timestamp', { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) {
    // Default to 90 days ago (Slack free tier limit)
    return Math.floor(Date.now() / 1000) - (90 * 24 * 60 * 60);
  }

  return Math.floor(new Date(data[0].timestamp).getTime() / 1000);
}

// Cache for user data to avoid hitting Slack API limits and unnecessary DB writes
// Map<userId, { slackUser: Object, lastChecked: number, dbSynced: boolean }>
const usersCache = new Map();

async function getUser(userId) {
  // Check cache first
  if (usersCache.has(userId)) {
    return usersCache.get(userId).slackUser;
  }

  try {
    const userInfo = await slack.users.info({ user: userId });
    if (userInfo.ok && userInfo.user) {
      usersCache.set(userId, {
        slackUser: userInfo.user,
        lastChecked: Date.now(),
        dbSynced: false
      });
      return userInfo.user;
    }
  } catch (err) {
    console.error(`Error fetching user ${userId}:`, err.message);
  }
  return null;
}

async function syncUser(slackUser) {
  if (!slackUser || !slackUser.id) return;

  const cacheEntry = usersCache.get(slackUser.id);
  // If we already synced this user in this run, skip
  if (cacheEntry && cacheEntry.dbSynced) return;

  try {
    // Check if user exists in DB and compare updated timestamp
    const { data: dbUser, error: fetchError } = await supabase
      .from('users')
      .select('updated')
      .eq('id', slackUser.id)
      .single();

    const needsUpdate = !dbUser || (slackUser.updated > (dbUser.updated || 0));

    if (needsUpdate) {
      console.log(`Syncing user ${slackUser.name} (${slackUser.id})...`);
      const { error: upsertError } = await supabase
        .from('users')
        .upsert([
          {
            id: slackUser.id,
            team_id: slackUser.team_id,
            name: slackUser.name,
            real_name: slackUser.real_name,
            display_name: slackUser.profile?.display_name,
            email: slackUser.profile?.email,
            deleted: slackUser.deleted,
            is_bot: slackUser.is_bot,
            is_admin: slackUser.is_admin,
            is_owner: slackUser.is_owner,
            updated: slackUser.updated,
            raw_json: slackUser,
            // created_at defaults to NOW()
          }
        ], { onConflict: 'id' });

      if (upsertError) {
        console.error(`Error upserting user ${slackUser.name}:`, upsertError);
      } else {
        console.log(`✓ User ${slackUser.name} synced`);
      }
    }

    // Update cache to mark as synced
    if (cacheEntry) {
      cacheEntry.dbSynced = true;
      usersCache.set(slackUser.id, cacheEntry);
    } else {
      usersCache.set(slackUser.id, {
        slackUser: slackUser,
        lastChecked: Date.now(),
        dbSynced: true
      });
    }

  } catch (err) {
    console.error(`Error syncing user ${slackUser.id}:`, err);
  }
}

async function storeMessage(message, channelId, channelName) {
  let username = null;

  if (message.user) {
    const user = await getUser(message.user);
    if (user) {
      username = user.name;
      // Trigger user sync in background/fire-and-forget or await if strict consistency needed
      // Awaiting specifically to ensure we capture the user data before message referencing it potentially
      await syncUser(user);
    }
  }

  const { error } = await supabase
    .from('messages')
    .upsert([
      {
        id: `${channelId}-${message.ts}`,
        channel_id: channelId,
        channel_name: channelName,
        user_id: message.user,
        username: username,
        text: message.text || '',
        timestamp: new Date(parseFloat(message.ts) * 1000).toISOString(),
        thread_ts: message.thread_ts || null,
        raw_json: message,
      },
    ], { onConflict: 'id' });

  if (error) {
    console.error('Supabase error:', error);
  }
}

async function syncChannel(channelId, channelName) {
  console.log(`Syncing ${channelName}...`);

  // Try to join the channel (only works for public channels)
  try {
    await slack.conversations.join({ channel: channelId });
    console.log(`✓ Joined ${channelName}`);
  } catch (err) {
    if (err.data?.error === 'already_in_channel') {
      console.log(`✓ Already in ${channelName}`);
    } else if (err.data?.error === 'method_not_supported_for_channel_type') {
      // Private channel - bot must be manually invited
      console.log(`✓ Private channel ${channelName} (manual invite required)`);
    } else if (err.data?.error === 'channel_not_found') {
      console.log(`✗ Cannot access ${channelName} (not invited)`);
      return 0;
    } else {
      console.error(`Failed to join ${channelName}:`, err.data?.error);
      return 0;
    }
  }

  const lastSync = await getLastSyncTime(channelId);
  let newMessages = 0;
  let cursor;
  let hasMore = true;

  while (hasMore) {
    try {
      const result = await slack.conversations.history({
        channel: channelId,
        oldest: lastSync.toString(),
        limit: 200,
        cursor: cursor,
      });

      for (const message of result.messages) {
        if (message.user) {
          await storeMessage(message, channelId, channelName);
          newMessages++;
        }
      }

      hasMore = result.has_more;
      cursor = result.response_metadata?.next_cursor;

      // Rate limiting
      if (hasMore) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (err) {
      console.error(`Error fetching history for ${channelName}:`, err.data?.error);
      break;
    }
  }

  console.log(`✓ Synced ${newMessages} new messages from ${channelName}`);
  return newMessages;
}

async function main() {
  try {
    console.log('Starting sync...');

    // Get all conversations the bot has access to
    const channelsResult = await slack.conversations.list({
      types: 'public_channel,private_channel,im,mpim',  // All types
      exclude_archived: true,
    });

    let totalMessages = 0;
    for (const channel of channelsResult.channels) {
      // For DMs, channel.name might be undefined, use channel.id as fallback
      const channelName = channel.name || channel.id;
      const count = await syncChannel(channel.id, channelName);
      totalMessages += count;
    }

    console.log(`\n✅ Sync complete! Total new messages: ${totalMessages}`);
  } catch (err) {
    console.error('❌ Sync failed:', err);
    process.exit(1);
  }
}

main();
