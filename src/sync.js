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

async function storeMessage(message, channelId, channelName) {
  let username = null;
  if (message.user) {
    try {
      const userInfo = await slack.users.info({ user: message.user });
      username = userInfo.user.name;
    } catch (err) {
      console.error('Error fetching user:', err);
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
  
  // Try to join the channel first
  try {
    await slack.conversations.join({ channel: channelId });
    console.log(`✓ Joined ${channelName}`);
  } catch (err) {
    if (err.data?.error === 'already_in_channel') {
      console.log(`✓ Already in ${channelName}`);
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
  }

  console.log(`✓ Synced ${newMessages} new messages from ${channelName}`);
  return newMessages;
}

async function main() {
  try {
    console.log('Starting sync...');
    
    // Get all public channels
    const channelsResult = await slack.conversations.list({
      types: 'public_channel',
      exclude_archived: true,
    });

    let totalMessages = 0;
    for (const channel of channelsResult.channels) {
      const count = await syncChannel(channel.id, channel.name);
      totalMessages += count;
    }

    console.log(`\n✅ Sync complete! Total new messages: ${totalMessages}`);
  } catch (err) {
    console.error('❌ Sync failed:', err);
    process.exit(1);
  }
}

main();
