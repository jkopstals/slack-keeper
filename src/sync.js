const { WebClient } = require('@slack/web-api');
const { createClient } = require('@supabase/supabase-js');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Configuration
const RECHECK_DAYS = parseInt(process.env.RECHECK_DAYS || '3', 10); // Days to re-check for edits/replies
const FULL_SYNC_DAYS = parseInt(process.env.FULL_SYNC_DAYS || '90', 10); // Slack free tier limit

async function getTodaySyncStatus() {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const { data, error } = await supabase
    .from('sync_log')
    .select('*')
    .eq('sync_date', today)
    .single();

  return { hasRunToday: !!data, syncLog: data };
}

async function recordSyncCompletion(totalMessages, totalReplies, channelsProcessed) {
  const today = new Date().toISOString().split('T')[0];

  const { error } = await supabase
    .from('sync_log')
    .upsert([
      {
        sync_date: today,
        completed_at: new Date().toISOString(),
        total_messages: totalMessages,
        total_replies: totalReplies,
        channels_processed: channelsProcessed,
      }
    ], { onConflict: 'sync_date' });

  if (error) {
    console.error('Error recording sync completion:', error);
  }
}

async function getOldestTimestamp(channelId) {
  const { data, error } = await supabase
    .from('messages')
    .select('timestamp')
    .eq('channel_id', channelId)
    .order('timestamp', { ascending: true })
    .limit(1);

  if (error || !data || data.length === 0) {
    return null;
  }

  return Math.floor(new Date(data[0].timestamp).getTime() / 1000);
}

async function getLastSyncTime(channelId) {
  const { data, error } = await supabase
    .from('messages')
    .select('timestamp')
    .eq('channel_id', channelId)
    .order('timestamp', { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) {
    // Default to FULL_SYNC_DAYS ago (Slack free tier limit)
    return Math.floor(Date.now() / 1000) - (FULL_SYNC_DAYS * 24 * 60 * 60);
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
        edited_timestamp: message.edited?.ts ? new Date(parseFloat(message.edited.ts) * 1000).toISOString() : null,
        raw_json: message,
      },
    ], { onConflict: 'id' });

  if (error) {
    console.error('Supabase error:', error);
  }
}

async function syncThreadReplies(channelId, channelName, threadTs) {
  let repliesCount = 0;
  let cursor;
  let hasMore = true;

  while (hasMore) {
    try {
      const result = await slack.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 200,
        cursor: cursor,
      });

      for (const message of result.messages) {
        // Skip the parent message (it's already stored)
        if (message.ts === threadTs) continue;

        if (message.user) {
          await storeMessage(message, channelId, channelName);
          repliesCount++;
        }
      }

      hasMore = result.has_more;
      cursor = result.response_metadata?.next_cursor;

      // Rate limiting
      if (hasMore) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (err) {
      console.error(`Error fetching replies for thread ${threadTs}:`, err.data?.error);
      break;
    }
  }

  return repliesCount;
}

async function recheckRecentMessages(channelId, channelName, daysToRecheck) {
  console.log(`  ↻ Re-checking last ${daysToRecheck} days for edits and new replies...`);

  const recheckFrom = Math.floor(Date.now() / 1000) - (daysToRecheck * 24 * 60 * 60);
  let updatedMessages = 0;
  let newReplies = 0;
  let cursor;
  let hasMore = true;

  while (hasMore) {
    try {
      const result = await slack.conversations.history({
        channel: channelId,
        oldest: recheckFrom.toString(),
        limit: 200,
        cursor: cursor,
      });

      for (const message of result.messages) {
        if (message.user) {
          // Re-store message (upsert will update if edited)
          await storeMessage(message, channelId, channelName);
          updatedMessages++;

          // Check for new replies in threads
          if (message.reply_count && message.reply_count > 0) {
            const repliesCount = await syncThreadReplies(channelId, channelName, message.ts);
            newReplies += repliesCount;
          }
        }
      }

      hasMore = result.has_more;
      cursor = result.response_metadata?.next_cursor;

      // Rate limiting
      if (hasMore) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (err) {
      console.error(`Error re-checking messages for ${channelName}:`, err.data?.error);
      break;
    }
  }

  console.log(`  ✓ Re-checked ${updatedMessages} messages, found ${newReplies} new replies`);
  return { updatedMessages, newReplies };
}

async function syncNewMessages(channelId, channelName, fromTimestamp) {
  console.log(`  → Fetching new messages since ${new Date(fromTimestamp * 1000).toISOString()}...`);

  let newMessages = 0;
  let newReplies = 0;
  let cursor;
  let hasMore = true;

  while (hasMore) {
    try {
      const result = await slack.conversations.history({
        channel: channelId,
        oldest: fromTimestamp.toString(),
        limit: 200,
        cursor: cursor,
      });

      for (const message of result.messages) {
        if (message.user) {
          await storeMessage(message, channelId, channelName);
          newMessages++;

          // If this message has replies, fetch them
          if (message.reply_count && message.reply_count > 0) {
            const repliesCount = await syncThreadReplies(channelId, channelName, message.ts);
            newReplies += repliesCount;
          }
        }
      }

      hasMore = result.has_more;
      cursor = result.response_metadata?.next_cursor;

      // Rate limiting
      if (hasMore) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (err) {
      console.error(`Error fetching new messages for ${channelName}:`, err.data?.error);
      break;
    }
  }

  console.log(`  ✓ Synced ${newMessages} new messages and ${newReplies} replies`);
  return { newMessages, newReplies };
}

async function syncChannel(channelId, channelName, isFullSync) {
  console.log(`\nSyncing ${channelName}...`);

  // Try to join the channel (only works for public channels)
  try {
    await slack.conversations.join({ channel: channelId });
    console.log(`✓ Joined ${channelName}`);
  } catch (err) {
    if (err.data?.error === 'already_in_channel') {
      console.log(`✓ Already in ${channelName}`);
    } else if (err.data?.error === 'method_not_supported_for_channel_type') {
      console.log(`✓ Private channel ${channelName} (manual invite required)`);
    } else if (err.data?.error === 'channel_not_found') {
      console.log(`✗ Cannot access ${channelName} (not invited)`);
      return { newMessages: 0, newReplies: 0 };
    } else {
      console.error(`Failed to join ${channelName}:`, err.data?.error);
      return { newMessages: 0, newReplies: 0 };
    }
  }

  let totalNewMessages = 0;
  let totalNewReplies = 0;

  if (isFullSync) {
    console.log(`📅 FULL SYNC - Re-checking all available history (up to ${FULL_SYNC_DAYS} days)`);

    // Full sync: fetch everything from the beginning or FULL_SYNC_DAYS ago
    const oldestTimestamp = await getOldestTimestamp(channelId);
    const fullSyncStart = oldestTimestamp || (Math.floor(Date.now() / 1000) - (FULL_SYNC_DAYS * 24 * 60 * 60));

    const { newMessages, newReplies } = await syncNewMessages(channelId, channelName, fullSyncStart);
    totalNewMessages += newMessages;
    totalNewReplies += newReplies;

  } else {
    console.log(`⚡ INCREMENTAL SYNC - Checking last ${RECHECK_DAYS} days + new messages`);

    // 1. Re-check recent messages for edits and new replies
    const { updatedMessages, newReplies: recheckReplies } = await recheckRecentMessages(
      channelId,
      channelName,
      RECHECK_DAYS
    );
    totalNewReplies += recheckReplies;

    // 2. Fetch truly new messages (beyond what we already have)
    const lastSync = await getLastSyncTime(channelId);
    const { newMessages, newReplies } = await syncNewMessages(channelId, channelName, lastSync);
    totalNewMessages += newMessages;
    totalNewReplies += newReplies;
  }

  console.log(`✅ ${channelName}: ${totalNewMessages} new messages, ${totalNewReplies} replies`);
  return { newMessages: totalNewMessages, newReplies: totalNewReplies };
}

async function main() {
  try {
    console.log('🚀 Starting Slack sync...\n');

    // Check if we've already run today
    const { hasRunToday, syncLog } = await getTodaySyncStatus();
    const isFullSync = !hasRunToday;

    if (hasRunToday) {
      console.log(`✓ Already synced today at ${syncLog.completed_at}`);
      console.log(`  Running incremental sync (re-checking last ${RECHECK_DAYS} days)\n`);
    } else {
      console.log(`✓ First sync of the day - running full sync\n`);
    }

    // Get all conversations the bot has access to
    const channelsResult = await slack.conversations.list({
      types: 'public_channel,private_channel,im,mpim',
      exclude_archived: true,
    });

    let totalMessages = 0;
    let totalReplies = 0;
    let channelsProcessed = 0;

    for (const channel of channelsResult.channels) {
      const channelName = channel.name || channel.id;
      const { newMessages, newReplies } = await syncChannel(channel.id, channelName, isFullSync);
      totalMessages += newMessages;
      totalReplies += newReplies;
      channelsProcessed++;
    }

    // Record this sync
    await recordSyncCompletion(totalMessages, totalReplies, channelsProcessed);

    console.log(`\n✅ Sync complete!`);
    console.log(`   📊 Total new messages: ${totalMessages}`);
    console.log(`   💬 Total replies: ${totalReplies}`);
    console.log(`   📁 Channels processed: ${channelsProcessed}`);
    console.log(`   🔄 Sync type: ${isFullSync ? 'FULL' : 'INCREMENTAL'}`);

  } catch (err) {
    console.error('❌ Sync failed:', err);
    process.exit(1);
  }
}

main();