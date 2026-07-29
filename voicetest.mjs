import { readFileSync } from 'fs';
import { Client, GatewayIntentBits, PermissionsBitField } from 'discord.js';
import { joinVoiceChannel, VoiceConnectionStatus, entersState } from '@discordjs/voice';

for (const line of readFileSync(new URL('./.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2];
}
const TOKEN = process.env.DISCORD_TOKEN;
const NETCODE = ['OpeningWs','Identifying','UdpHandshaking','SelectingProtocol','Ready','Resuming','Closed'];

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

client.once('clientReady', async () => {
  console.log(`logged in as ${client.user.tag}`);
  const guild = client.guilds.cache.first();
  if (!guild) { console.log('no guild'); process.exit(1); }
  await guild.channels.fetch();
  const me = await guild.members.fetchMe();
  const vc = guild.channels.cache.find(c => c.type === 2 && c.permissionsFor(me).has(PermissionsBitField.Flags.Connect));
  if (!vc) { console.log('no joinable voice channel (check Connect perms)'); process.exit(1); }
  console.log(`joining voice channel: #${vc.name} (${vc.id})`);

  const conn = joinVoiceChannel({ channelId: vc.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false });
  let hooked = null;
  conn.on('error', e => console.error('conn-error:', e.message));
  conn.on('debug', m => console.log('conn-debug:', m));
  conn.on('stateChange', (o, n) => {
    const net = n.networking;
    if (net && net !== hooked) {
      hooked = net;
      net.on('stateChange', (a, b) => { if (a.code !== b.code) console.log(`  NET ${NETCODE[a.code] ?? a.code} -> ${NETCODE[b.code] ?? b.code}`); });
      net.on('error', e => console.error('  NET-error:', e?.message || e));
      net.on('close', code => console.log('  NET ws closed code=', code));
    }
    if (o.status !== n.status) console.log(`STATE ${o.status} -> ${n.status}`);
  });

  try {
    await entersState(conn, VoiceConnectionStatus.Ready, 25000);
    console.log('\n✅✅✅ REACHED READY — voice handshake works! Audio path is fine.');
  } catch (e) {
    console.log('\n❌ never reached Ready within 25s:', e.message);
  } finally {
    try { conn.destroy(); } catch {}
    setTimeout(() => process.exit(0), 800);
  }
});

client.login(TOKEN).catch(e => { console.error('login failed:', e.message); process.exit(1); });
setTimeout(() => { console.log('hard timeout'); process.exit(2); }, 40000);
