const { WebClient } = require('@slack/web-api');
const { createClient } = require('@supabase/supabase-js');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Configuration
const RECHECK_BUFFER_HOURS = parseInt(process.env.RECHECK_BUFFER_HOURS || '24', 10); // Buffer before last sync
const FULL_SYNC_DAYS = parseInt(process.env.FULL_SYNC_DAYS || '90', 10); // Slack free tier limit

async function getLastSuccessfulSync() {
  const { data, error } = await supabase
    .from('sync_log')
    .select('*')
    .order('completed_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    return null;
  }

  return data;
}

async function recordSyncStart() {
  const syncId = Date.now().toString();
  const { error } = await supabase
    .from('sync_log')
    .insert([
      {
        sync_id: syncId,
        started_at: new Date().toISOString(),
        status: 'running',
      }
    ]);

  if (error) {
    console.error('Error recording sync start:', error);
  }

  return syncId;
}

async function recordSyncCompletion(syncId, totalMessages, totalReplies, channelsProcessed) {
  const { error } = await supabase
    .from('sync_log')
    .update({
      completed_at: new Date().toISOString(),
      status: 'completed',
      total_messages: totalMessages,
      total_replies: totalReplies,
      channels_processed: channelsProcessed,
    })
    .eq('sync_id', syncId);

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
          }
        ], { onConflict: 'id' });

      if (upsertError) {
        console.error(`Error upserting user ${slackUser.name}:`, upsertError);
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

async function syncMessagesInRange(channelId, channelName, fromTimestamp, toTimestamp, label) {
  const fromDate = new Date(fromTimestamp * 1000).toISOString().substring(0, 16);
  const toDate = toTimestamp ? new Date(toTimestamp * 1000).toISOString().substring(0, 16) : 'now';

  console.log(`  ${label} (${fromDate} to ${toDate})...`);

  let processedMessages = 0;
  let newReplies = 0;
  let cursor;
  let hasMore = true;

  while (hasMore) {
    try {
      const params = {
        channel: channelId,
        oldest: fromTimestamp.toString(),
        limit: 200,
        cursor: cursor,
      };

      // Add latest parameter if we have a toTimestamp
      if (toTimestamp) {
        params.latest = toTimestamp.toString();
      }

      const result = await slack.conversations.history(params);

      for (const message of result.messages) {
        if (message.user) {
          await storeMessage(message, channelId, channelName);
          processedMessages++;

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
      console.error(`Error fetching messages for ${channelName}:`, err.data?.error);
      break;
    }
  }

  console.log(`  ✓ Processed ${processedMessages} messages, ${newReplies} replies`);
  return { processedMessages, newReplies };
}

async function syncChannel(channelId, channelName, lastSync) {
  console.log(`\nSyncing ${channelName}...`);

  // Try to join the channel (only works for public channels)
  try {
    await slack.conversations.join({ channel: channelId });
    console.log(`✓ Already in ${channelName}`);
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

  let totalProcessed = 0;
  let totalReplies = 0;

  if (!lastSync) {
    // First ever sync - get all available history
    console.log(`📅 INITIAL SYNC - Fetching all available history (up to ${FULL_SYNC_DAYS} days)`);
    const fullSyncStart = Math.floor(Date.now() / 1000) - (FULL_SYNC_DAYS * 24 * 60 * 60);

    const { processedMessages, newReplies } = await syncMessagesInRange(
      channelId,
      channelName,
      fullSyncStart,
      null,
      '→ Fetching all messages'
    );
    totalProcessed += processedMessages;
    totalReplies += newReplies;

  } else {
    // Calculate recheck window: last sync time - buffer
    const lastSyncTime = new Date(lastSync.started_at).getTime() / 1000;
    const recheckFrom = lastSyncTime - (RECHECK_BUFFER_HOURS * 60 * 60);
    const lastMessageTime = await getLastSyncTime(channelId);

    console.log(`⚡ INCREMENTAL SYNC`);
    console.log(`   Last sync: ${lastSync.started_at} (${RECHECK_BUFFER_HOURS}h buffer)`);

    // 1. Re-check messages that might have been edited or got new replies
    //    (from lastSyncTime - buffer to lastSyncTime)
    if (recheckFrom < lastSyncTime) {
      const { processedMessages, newReplies } = await syncMessagesInRange(
        channelId,
        channelName,
        recheckFrom,
        lastSyncTime,
        '↻ Re-checking for edits/replies'
      );
      totalReplies += newReplies;
    }

    // 2. Fetch truly new messages (from last message time to now)
    if (lastMessageTime) {
      const { processedMessages, newReplies } = await syncMessagesInRange(
        channelId,
        channelName,
        lastMessageTime,
        null,
        '→ Fetching new messages'
      );
      totalProcessed += processedMessages;
      totalReplies += newReplies;
    }
  }

  console.log(`✅ ${channelName}: ${totalProcessed} new messages, ${totalReplies} replies`);
  return { newMessages: totalProcessed, newReplies: totalReplies };
}

async function main() {
  try {
    console.log('🚀 Starting Slack sync...\n');

    const syncId = await recordSyncStart();
    const lastSync = await getLastSuccessfulSync();

    if (lastSync) {
      const lastSyncDate = new Date(lastSync.completed_at);
      const hoursSinceLastSync = (Date.now() - lastSyncDate.getTime()) / (1000 * 60 * 60);

      console.log(`✓ Last successful sync: ${lastSync.completed_at}`);
      console.log(`  (${hoursSinceLastSync.toFixed(1)} hours ago)`);
      console.log(`  Re-checking ${RECHECK_BUFFER_HOURS}h buffer for edits/replies\n`);
    } else {
      console.log(`✓ First sync ever - will fetch all available history\n`);
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
      const { newMessages, newReplies } = await syncChannel(channel.id, channelName, lastSync);
      totalMessages += newMessages;
      totalReplies += newReplies;
      channelsProcessed++;
    }

    // Record this sync as completed
    await recordSyncCompletion(syncId, totalMessages, totalReplies, channelsProcessed);

    console.log(`\n✅ Sync complete!`);
    console.log(`   📊 New messages: ${totalMessages}`);
    console.log(`   💬 Replies: ${totalReplies}`);
    console.log(`   📁 Channels: ${channelsProcessed}`);

  } catch (err) {
    console.error('❌ Sync failed:', err);
    process.exit(1);
  }
}

main();