// R6 SellAuth Discord bot.
//
//   /restock  (owner)  — append accounts to a SellAuth product + announce
//   /replace  (owner)  — email a replacement account for a verified order
//   reaction role      — self-assign the restock-ping role
//
// Run with:  node bot.js     (needs the DISCORD_*/SELLAUTH_*/...ROLE_ID keys
// in .env — see lib/bot/config.js).

const {
  Client, GatewayIntentBits, Partials, REST, Routes, Events,
} = require('discord.js');
const { cfg, assertConfigured } = require('./lib/bot/config');
const reactionRole = require('./lib/bot/reactionRole');
const stockWatcher = require('./lib/bot/stockWatcher');
const joinRole = require('./lib/bot/joinRole');
const welcome = require('./lib/bot/welcome');
const inviteTracker = require('./lib/bot/inviteTracker');
const inviteLog = require('./lib/bot/inviteLog');
const buyerRole = require('./lib/bot/buyerRole');
const mpHttpServer = require('./lib/bot/mpHttpServer');
const salesFeed = require('./lib/bot/salesFeed');
const ownerEmbed = require('./lib/bot/ownerEmbed');

assertConfigured();

const mpDeal = require('./lib/bot/mpDeal');
const commands = {
  restock:    require('./lib/bot/commands/restock'),
  replace:    require('./lib/bot/commands/replace'),
  price:      require('./lib/bot/commands/price'),
  addbalance: require('./lib/bot/commands/addbalance'),
  recheck:    require('./lib/bot/commands/recheck'),
  syncstore:  require('./lib/bot/commands/syncstore'),
  syncallstock: require('./lib/bot/commands/syncallstock'),
  syncvariants: require('./lib/bot/commands/syncvariants'),
  checkall:   require('./lib/bot/commands/checkall'),
  promoter:   require('./lib/bot/commands/promoter'),
  setupsales: require('./lib/bot/commands/setupsales'),
  setupserver: require('./lib/bot/commands/setupserver'),
  setupverify: require('./lib/bot/commands/setupverify'),
  invites:    require('./lib/bot/commands/invites'),
  close:      mpDeal.closeCommand,
};

// GuildMembers + MessageContent are PRIVILEGED — both must be enabled in the
// Discord developer portal (Bot → Privileged Gateway Intents). GuildMembers:
// auto join-role + backfill. MessageContent + DirectMessages: read DMs for
// buyer-role invoice claims. If they're NOT enabled, login throws "disallowed
// intents"; we then fall back to BASE intents so the rest of the bot still runs.
const BASE_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildInvites];
const PRIVILEGED_INTENTS = [
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.DirectMessages,
];
const PARTIALS = [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember];

let client;          // current Client
let privileged = true; // whether the privileged-intent features are active

function buildClient(intents) {
  return new Client({ intents, partials: PARTIALS });
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(cfg.token);
  const body = Object.values(commands).map(c => c.data.toJSON());
  await rest.put(
    Routes.applicationGuildCommands(client.user.id, cfg.guildId),
    { body },
  );
  console.log(`[bot] registered ${body.length} guild command(s): ${Object.keys(commands).join(', ')}`);
}

function wireEvents(c) {
  c.once(Events.ClientReady, async (ready) => {
    console.log(`[bot] logged in as ${ready.user.tag}${privileged ? '' : ' (LIMITED mode — privileged intents off)'}`);
    try { await registerCommands(); } catch (e) { console.error('[bot] command registration failed:', e.message); }
    try { await reactionRole.ensureMessage(c); } catch (e) { console.error('[bot] reaction-role setup failed:', e.message); }
    try { await buyerRole.ensureEmbed(c); } catch (e) { console.error('[bot] buyer-role embed setup failed:', e.message); }
    try { stockWatcher.start(c); } catch (e) { console.error('[bot] stock watcher failed:', e.message); }
    try { mpHttpServer.start(c); } catch (e) { console.error('[bot] marketplace listener failed:', e.message); }
    try { salesFeed.start(c); } catch (e) { console.error('[bot] sales feed failed:', e.message); }
    try { await inviteTracker.prime(c); } catch (e) { console.error('[bot] invite-tracker prime failed:', e.message); }
    if (privileged) {
      try {
        const guild = c.guilds.cache.get(cfg.guildId) || await c.guilds.fetch(cfg.guildId);
        await joinRole.backfill(guild);
      } catch (e) { console.error('[bot] join-role backfill failed:', e.message); }
    } else {
      console.warn('[bot] join-role + DM buyer-claims are OFF. Enable "Server Members" + "Message Content" intents in the Discord portal, then restart. (Buyer role still claimable via the embed button.)');
    }
    console.log('[bot] ready');
  });

  if (privileged) {
    c.on(Events.GuildMemberAdd, (member) => { joinRole.onJoin(member); welcome.onJoin(member); });
    c.on(Events.MessageCreate, (message) => {
      buyerRole.onDirectMessage(message).catch(e => console.warn('[bot] DM handler error:', e.message));
      // Owner messages → themed embeds (guild only; handled first so it can
      // delete+repost before other handlers act on the original).
      ownerEmbed.onMessage(message).catch(e => console.warn('[bot] ownerEmbed error:', e.message));
      // Typed "finish" / "cancel" in a marketplace deal channel (buttons are the
      // primary path and work without the MessageContent intent; typing is a
      // convenience that requires it).
      mpDeal.onMessage(message).catch(e => console.warn('[bot] mpDeal msg error:', e.message));
    });
  }

  c.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isAutocomplete()) {
        const cmd = commands[interaction.commandName];
        if (cmd && cmd.autocomplete) await cmd.autocomplete(interaction);
        return;
      }
      if (interaction.isButton()) {
        // Marketplace deal buttons take priority (custom_id mpdeal:*).
        if (await mpDeal.onButton(interaction)) return;
        if (await commands.restock.onButton(interaction)) return;   // restock:announce
        if (await commands.checkall.onButton(interaction)) return;  // checkall:go
        await buyerRole.onButton(interaction); return;
      }
      if (interaction.isModalSubmit()) { await buyerRole.onModal(interaction); return; }
      if (interaction.isChatInputCommand()) {
        const cmd = commands[interaction.commandName];
        if (cmd) await cmd.execute(interaction);
      }
    } catch (e) {
      console.error(`[bot] handler error (${interaction.commandName}):`, e);
      const msg = '❌ Something went wrong handling that command.';
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
        else await interaction.reply({ content: msg, ephemeral: true });
      } catch { /* interaction already gone */ }
    }
  });

  c.on(Events.MessageReactionAdd,    (r, u) => reactionRole.onAdd(r, u));
  c.on(Events.MessageReactionRemove, (r, u) => reactionRole.onRemove(r, u));
  // Keep the invite-use cache fresh so joins resolve to the right invite.
  c.on(Events.InviteCreate, (invite) => inviteTracker.onInviteCreate(invite));
  c.on(Events.InviteDelete, (invite) => inviteTracker.onInviteDelete(invite));
  if (privileged) c.on(Events.GuildMemberRemove, (member) => inviteLog.markLeft(member.id));
  c.on(Events.GuildCreate,  (guild)  => inviteTracker.primeGuild(guild).catch(() => {}));
  c.on('error', e => console.error('[bot] client error:', e.message));
}

async function boot() {
  client = buildClient([...BASE_INTENTS, ...PRIVILEGED_INTENTS]);
  wireEvents(client);
  try {
    await client.login(cfg.token);
  } catch (e) {
    if (/disallowed intents/i.test(e.message || '')) {
      console.error('\n[bot] ⚠️  PRIVILEGED INTENTS NOT ENABLED in the Discord portal.');
      console.error('[bot]     Enable BOTH "Server Members Intent" and "Message Content Intent" at:');
      console.error('[bot]     https://discord.com/developers/applications → your app → Bot → Privileged Gateway Intents');
      console.error('[bot]     Starting in LIMITED mode (commands, reaction role, stock alerts, buyer-button all work).\n');
      privileged = false;
      try { client.destroy(); } catch {}
      client = buildClient(BASE_INTENTS);
      wireEvents(client);
      await client.login(cfg.token);
    } else {
      throw e;
    }
  }
}

process.on('unhandledRejection', e => console.error('[bot] unhandledRejection:', e && e.message ? e.message : e));
boot().catch(e => { console.error('[bot] fatal:', e.message); process.exit(1); });
