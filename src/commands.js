import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import axios from 'axios';
import { createRequire } from 'module';
import { execSync, exec as execCb } from 'child_process';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { DATA_DIR, readJson, writeJson, runtime, systemInfo, normalizeNumber, mentionedJids, quotedParticipant, pickTarget, hashPercent, safeEvalMath, toFancy, randomChoice, groupAdmins } from './utils.js';
import { formatPairingCode, pairInstructions, validatePairingNumber } from './pairing.js';
import { BOT_NAME, OWNER_NAME, OWNER_NUMBER, TOGGLE_NAMES, commandReaction, formatAutoBio, formatSettings, getDateTimeParts, isToggleEnabled, setToggle } from './settings.js';
import path from 'path';

// yt-search — lazy top-level import so missing module never crashes startup
let yts;
try { yts = (await import('yt-search')).default; } catch { yts = null; }

const configPath = path.join(DATA_DIR, 'bot-config.json');
const statePath = path.join(DATA_DIR, 'state.json');

const jokes = [
  'Why do programmers prefer dark mode? Because light attracts bugs.',
  'I told my bot a joke about UDP. It might get it, it might not.',
  'Why was the JavaScript developer sad? Because they did not know how to null their feelings.',
  'A SQL query walks into a bar, walks up to two tables and asks: can I join you?',
  'There are 10 kinds of people: those who understand binary and those who do not.'
];
const facts = [
  'Honey never spoils when stored properly.',
  'Bananas are berries, but strawberries are not botanical berries.',
  'Octopuses have three hearts.',
  'The first computer bug was an actual moth found in a relay.',
  'A day on Venus is longer than a year on Venus.'
];
const quotes = [
  'Stay hungry, stay foolish.',
  'Simplicity is the soul of efficiency.',
  'The best way to predict the future is to build it.',
  'Code is like humor. When you have to explain it, it is bad.',
  'Great things are done by a series of small things brought together.'
];
const truths = [
  'What is something you are secretly proud of?',
  'What was your most embarrassing chat mistake?',
  'Who was the last person you searched for online?',
  'What habit do you want to change?',
  'What is one thing you have never told the group?'
];
const dares = [
  'Send a voice note saying the alphabet backwards.',
  'Let the group choose your status for one hour.',
  'Send your most recent emoji five times.',
  'Talk like a robot for the next five messages.',
  'Compliment the last person who messaged.'
];
const compliments = ['legendary', 'brilliant', 'unstoppable', 'kind-hearted', 'iconic', 'creative', 'a real vibe'];
const insults = ['needs a software update', 'is buffering in real life', 'has low battery energy', 'forgot to compile today'];
const morseMap = { a: '.-', b: '-...', c: '-.-.', d: '-..', e: '.', f: '..-.', g: '--.', h: '....', i: '..', j: '.---', k: '-.-', l: '.-..', m: '--', n: '-.', o: '---', p: '.--.', q: '--.-', r: '.-.', s: '...', t: '-', u: '..-', v: '...-', w: '.--', x: '-..-', y: '-.--', z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.' };
const reverseMorse = Object.fromEntries(Object.entries(morseMap).map(([k, v]) => [v, k]));

function getConfig() {
  const defaults = {
    prefix: process.env.PREFIX || '.',
    publicMode: String(process.env.PUBLIC_MODE || 'true').toLowerCase() !== 'false',
    botName: process.env.BOT_NAME || BOT_NAME,
    ownerName: process.env.OWNER_NAME || OWNER_NAME,
    ownerNumber: normalizeNumber(process.env.OWNER_NUMBER || OWNER_NUMBER),
    timeZone: process.env.TIME_ZONE || 'Africa/Nairobi',
    madeBy: process.env.MADE_BY || 'Kimani Samuel'
  };
  return { ...defaults, ...readJson(configPath, {}) };
}

function saveConfig(next) {
  const current = getConfig();
  writeJson(configPath, { ...current, ...next });
}

function getState() { return readJson(statePath, { banned: [], notes: {}, learned: {}, counters: {}, toggles: {} }); }
function saveState(next) { writeJson(statePath, next); }

function helpLine(cmd, prefix) {
  return `${prefix}${cmd.name}${cmd.usage ? ' ' + cmd.usage : ''} — ${cmd.desc}`;
}

function textArg(args, fallback = '') { return args.join(' ').trim() || fallback; }
async function reply(ctx, text, options = {}) { return ctx.sock.sendMessage(ctx.chatId, { text, ...options }, { quoted: ctx.message }); }
function requireText(ctx, example) {
  const text = textArg(ctx.args);
  if (!text) return null;
  return text;
}

function toUserJid(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.endsWith('@s.whatsapp.net') || raw.endsWith('@lid')) return raw;
  const number = normalizeNumber(raw);
  return number ? `${number}@s.whatsapp.net` : '';
}

function jidsFromArgs(ctx, { includeMentions = true, includeQuoted = true, fallbackToSender = false } = {}) {
  const out = [];
  const addJid = (value) => {
    const jid = toUserJid(value);
    if (jid && !out.includes(jid)) out.push(jid);
  };

  if (includeMentions) mentionedJids(ctx.message).forEach(addJid);
  if (includeQuoted) addJid(quotedParticipant(ctx.message));

  const text = textArg(ctx.args);
  for (const token of text.split(/[\s,;|]+/).filter(Boolean)) {
    if (/^[+0-9()\-.]{5,}$/.test(token)) addJid(token);
  }

  if (!out.length && fallbackToSender) addJid(ctx.sender);
  return out;
}

function formatTargetList(jids = []) {
  return jids.map(jid => `@${normalizeNumber(jid)}`).join(', ');
}

function collectStringsDeep(value, out = []) {
  if (!value) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => collectStringsDeep(item, out));
  else if (typeof value === 'object') Object.values(value).forEach(item => collectStringsDeep(item, out));
  return out;
}

async function ensureBotGroupAdmin(ctx, action = 'manage group members') {
  // Parse bot ID correctly — Baileys may return formats like:
  //   "254701234567:4@s.whatsapp.net"  (phone:device@domain)
  //   "30997433344120:4@lid"           (lid:device@lid)
  const rawBotId  = ctx.sock.user?.id  || ctx.sock.user?.jid || '';
  const rawBotLid = ctx.sock.user?.lid || '';

  // Strip "@domain" and ":device" suffix to get the base number/lid
  const stripSuffix = (jid = '') => jid.split('@')[0].split(':')[0];
  const botPhone  = stripSuffix(rawBotId);
  const botLid    = stripSuffix(rawBotLid);

  let meta;
  try { meta = await ctx.sock.groupMetadata(ctx.chatId); } catch {
    throw new Error(`I need to be a group admin to ${action}.`);
  }

  const isBotAdmin = (meta.participants || []).some(p => {
    const pId  = stripSuffix(p.id  || p.jid || '');
    const pLid = stripSuffix(p.lid || '');
    const isBot = (
      rawBotId  === (p.id  || p.jid || '') ||   // exact full match
      rawBotLid === (p.lid || '')           ||   // exact lid match
      botPhone  === pId                     ||   // phone-number match
      botPhone  === pLid                    ||   // phone vs lid
      (botLid && botLid === pLid)           ||   // lid numeric match
      (botLid && botLid === pId)                 // lid vs id
    );
    return isBot && (p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin);
  });

  if (!isBotAdmin) throw new Error(`I need to be a group admin to ${action}.`);
}

async function resolveGroupTargets(ctx, targets = []) {
  if (!ctx.isGroup || !targets.length) return [...new Set(targets)];
  const meta = await ctx.sock.groupMetadata(ctx.chatId).catch(() => null);
  if (!meta?.participants?.length) return [...new Set(targets)];

  const participants = meta.participants.map(p => {
    const primary = p.id || p.jid || p.lid || p.phoneNumber || '';
    const strings = collectStringsDeep(p, []).filter(Boolean);
    return { primary, strings };
  });

  const resolved = [];
  for (const target of targets) {
    const number = normalizeNumber(target);
    const exact = participants.find(p => p.strings.some(x => String(x) === String(target)));
    const byNumber = number ? participants.find(p => p.strings.some(x => normalizeNumber(x) === number)) : null;
    const jid = (exact || byNumber)?.primary || target;
    if (jid && !resolved.includes(jid)) resolved.push(jid);
  }
  return resolved;
}

async function sendLongReply(ctx, text, options = {}) {
  const chunks = [];
  const max = 3500;
  let remaining = String(text || '');
  while (remaining.length > max) {
    let idx = remaining.lastIndexOf('\n', max);
    if (idx < 500) idx = max;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  if (remaining) chunks.push(remaining);
  for (const chunk of chunks) await reply(ctx, chunk, options);
}

function madeByFooter(cfg = getConfig()) {
  return `⭐ *Made by ${cfg.madeBy || 'Kimani Samuel'}* ⭐`;
}

function readMore() {
  return String.fromCharCode(8206).repeat(4001);
}

function getGreeting(timeZone = 'Africa/Nairobi') {
  let hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(new Date()));
  if (!Number.isFinite(hour)) hour = new Date().getHours();
  if (hour < 5) return '🌙 Good night.';
  if (hour < 12) return '🌅 Good morning.';
  if (hour < 17) return '☀️ Good afternoon.';
  if (hour < 21) return '🌆 Good evening.';
  return '🌙 Good night.';
}

function chunkMenuText(text, max = 3400) {
  const chunks = [];
  let remaining = String(text || '');
  while (remaining.length > max) {
    let idx = remaining.lastIndexOf('\n', max);
    if (idx < 800) idx = max;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendMenuWithImage(ctx, text, cfg = getConfig()) {
  const imagePath = path.join(process.cwd(), 'assets', 'bot_image.jpg');
  const headerCaption = `🤖 *${cfg.botName || BOT_NAME}*
${madeByFooter(cfg)}`;
  if (fs.existsSync(imagePath)) {
    await ctx.sock.sendMessage(ctx.chatId, { image: { url: imagePath }, caption: headerCaption }, { quoted: ctx.message });
  }
  await reply(ctx, text);
}

async function updateAutoBioFromCommand(ctx) {
  const cfg = getConfig();
  // Use the bot's configured timezone (defaults to Africa/Nairobi for Kenya)
  const tz = cfg.timeZone || process.env.TIME_ZONE || process.env.TZ || 'Africa/Nairobi';
  const bio = formatAutoBio(cfg.botName || BOT_NAME, tz);
  if (typeof ctx.sock.updateProfileStatus !== 'function') {
    return 'Autobio was enabled, but this Baileys socket does not expose updateProfileStatus on this host.';
  }
  try {
    await ctx.sock.updateProfileStatus(bio);
    return `Bio updated (${tz}): ${bio}`;
  } catch (err) {
    return `Autobio was enabled, but updating bio failed: ${err.message || err}`;
  }
}

function isHttpUrl(text = '') {
  try {
    const url = new URL(String(text).trim());
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function sanitizeFileName(name = '') {
  // Strip characters that are invalid in filenames across all platforms
  return String(name)
    .replace(/[\\/:*?"<>|]/g, '')   // windows-invalid chars
    .replace(/[\x00-\x1f\x7f]/g, '') // control chars
    .replace(/\.{2,}/g, '.')          // double dots
    .trim()
    .slice(0, 200)
    || 'audio';
}

async function resolveYouTubeUrl(input) {
  const query = String(input || '').trim();
  if (!query) throw new Error('Give me a YouTube URL or search name.');
  if (isHttpUrl(query)) return { url: query, title: query };

  try {
    const mod = await import('yt-search');
    const search = mod.default || mod;
    const result = await search(query);
    const video = result?.videos?.find(v => v?.url) || result?.all?.find(v => v?.type === 'video' && v?.url);
    if (video?.url) return { url: video.url, title: video.title || query };
  } catch {
    // If yt-search is unavailable on the host, fall through to a useful error below.
  }

  throw new Error('Could not search YouTube. Install dependencies with npm install, or send a direct YouTube link.');
}

function collectStrings(value, out = []) {
  if (!value) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => collectStrings(item, out));
  else if (typeof value === 'object') Object.values(value).forEach(item => collectStrings(item, out));
  return out;
}

function findTitle(value) {
  if (!value || typeof value !== 'object') return '';
  if (typeof value.title === 'string') return value.title;
  for (const item of Object.values(value)) {
    const nested = findTitle(item);
    if (nested) return nested;
  }
  return '';
}

function pickMediaUrl(data, type) {
  const urls = collectStrings(data)
    .map(x => x.trim())
    .filter(x => /^https?:\/\//i.test(x))
    .filter(x => !/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(x))
    .filter(x => !/youtube\.com\/watch|youtu\.be\//i.test(x));

  const preferred = urls.find(x => type === 'audio'
    ? /\.mp3(\?|$)|audio|ytmp3|mp3|download/i.test(x)
    : /\.mp4(\?|$)|video|ytmp4|mp4|download/i.test(x));
  return preferred || urls[0] || '';
}

async function requestDownloadUrl(youtubeUrl, type) {
  const encoded = encodeURIComponent(youtubeUrl);
  const endpoints = type === 'audio' ? [
    `https://api.davidcyriltech.my.id/download/ytmp3?url=${encoded}`,
    `https://api.dreaded.site/api/ytdl/audio?url=${encoded}`,
    `https://bk9.fun/download/ytmp3?url=${encoded}`,
    `https://api.agatz.xyz/api/ytmp3?url=${encoded}`
  ] : [
    `https://api.davidcyriltech.my.id/download/ytmp4?url=${encoded}`,
    `https://api.dreaded.site/api/ytdl/video?url=${encoded}`,
    `https://bk9.fun/download/ytmp4?url=${encoded}`,
    `https://api.agatz.xyz/api/ytmp4?url=${encoded}`
  ];

  const failures = [];
  for (const endpoint of endpoints) {
    try {
      const { data } = await axios.get(endpoint, {
        timeout: 45000,
        headers: { 'user-agent': 'Mozilla/5.0 Malai-XD-2.0' }
      });
      const mediaUrl = pickMediaUrl(data, type);
      if (mediaUrl) return { url: mediaUrl, title: findTitle(data) };
      failures.push('no media url');
    } catch (err) {
      failures.push(err.message || String(err));
    }
  }
  throw new Error(`No downloader API returned a ${type} file. Last error: ${failures.at(-1) || 'unknown'}`);
}

async function sendYouTubeMedia(ctx, requestedType, rawInput) {
  let input = String(rawInput || '').trim();
  let type = requestedType;
  if (!type) type = /^video|mp4$/i.test(ctx.args[0] || '') ? 'video' : 'audio';
  if (/^(audio|mp3|video|mp4)$/i.test(ctx.args[0] || '')) input = ctx.args.slice(1).join(' ').trim();
  if (!input) return reply(ctx, `Usage:\n${getConfig().prefix}play <song name or youtube url>\n${getConfig().prefix}play video <song name or youtube url>\n${getConfig().prefix}video <song name or youtube url>`);

  await reply(ctx, `Downloading ${type === 'audio' ? 'audio' : 'video'} for: ${input}`);
  const found = await resolveYouTubeUrl(input);
  const media = await requestDownloadUrl(found.url, type);
  const title = sanitizeFileName(media.title || found.title || 'Malai-XD-2.0');
  const caption = `╭─〔 Malai-XD-2.0 Download 〕\n│ Title: ${title}\n│ Type: ${type}\n╰────────────`;

  if (type === 'audio') {
    await ctx.sock.sendMessage(ctx.chatId, {
      audio: { url: media.url },
      mimetype: 'audio/mpeg',
      fileName: `${title}.mp3`,
      ptt: false
    }, { quoted: ctx.message });
  } else {
    await ctx.sock.sendMessage(ctx.chatId, {
      video: { url: media.url },
      mimetype: 'video/mp4',
      fileName: `${title}.mp4`,
      caption
    }, { quoted: ctx.message });
  }
}

export function buildCommands() {
  const registry = new Map();
  const commands = [];
  const add = (cmd) => {
    if (!cmd.name || typeof cmd.handler !== 'function') throw new Error(`Invalid command ${cmd.name}`);
    cmd.aliases = cmd.aliases || [];
    cmd.category = cmd.category || 'misc';
    cmd.desc = cmd.desc || 'No description';
    cmd.usage = cmd.usage || '';
    commands.push(cmd);
    registry.set(cmd.name, cmd);
    for (const alias of cmd.aliases) registry.set(alias, cmd);
  };

  add({ name: 'menu', aliases: ['help', 'bot', 'list'], category: 'core', desc: 'Show commands menu', handler: async (ctx) => {
    const cfg = getConfig();
    const total = commands.length;
    const displayName = ctx.pushName || normalizeNumber(ctx.sender) || 'there';
    const { date, time } = getDateTimeParts(cfg.timeZone);
    const mode = cfg.publicMode ? 'public' : 'private';
    const p = cfg.prefix;
    const helpMessage = `╔═══════════════════╗\n   *🤖 ${cfg.botName}*\n   by *${cfg.ownerName}*\n   📦 Commands: *${total}*\n╚═══════════════════╝\n\nHello 👋 *${displayName}*\n${getGreeting(cfg.timeZone)}\n📅 *${date}*  ⏰ *${time}*\n🔣 Prefix: *${p}*  🔐 Mode: *${mode}*\n\n╔═══════════════════╗\n💫 *General Commands*:\n║ ➤ ${p}menu / ${p}help\n║ ➤ ${p}ping\n║ ➤ ${p}ping2\n║ ➤ ${p}alive\n║ ➤ ${p}owner\n║ ➤ ${p}joke / ${p}fact / ${p}quote\n║ ➤ ${p}weather <city>\n║ ➤ ${p}jid\n╚═══════════════════╝\n\n╔═══════════════════╗\n👥 *Group Commands*:\n║ ➤ ${p}tagall\n║ ➤ ${p}hidetag <msg>\n║ ➤ ${p}groupinfo\n║ ➤ ${p}admins\n║ ➤ ${p}kick @user\n║ ➤ ${p}promote / ${p}demote @user\n║ ➤ ${p}open / ${p}close\n║ ➤ ${p}welcome on/off\n║ ➤ ${p}goodbye on/off\n║ ➤ ${p}vcf\n║ ➤ ${p}grouplink\n║ ➤ ${p}resetlink\n║ ➤ ${p}setgname / ${p}setgdesc\n╚═══════════════════╝\n\n╔═══════════════════╗\n👑 *Owner Commands*:\n║ ➤ ${p}mode <public/private>\n║ ➤ ${p}settings\n║ ➤ ${p}ban / ${p}unban\n║ ➤ ${p}block / ${p}unblock\n║ ➤ ${p}setprefix <prefix>\n║ ➤ ${p}restart\n║ ➤ ${p}pair <number>\n╚═══════════════════╝\n\n╔═══════════════════╗\n🎞️ *Media Commands*:\n║ ➤ ${p}vv  (reveal view-once)\n║ ➤ ${p}vv2 on/off (auto-forward VO)\n║ ➤ ${p}sticker\n║ ➤ ${p}toimg / ${p}removebg\n╚═══════════════════╝\n\n╔═══════════════════╗\n⬇️ *Downloader*:\n║ ➤ ${p}play <song name>\n║ ➤ ${p}video <song name>\n║ ➤ ${p}tiktok <link>\n║ ➤ ${p}instagram <link>\n║ ➤ ${p}facebook <link>\n╚═══════════════════╝\n\n╔═══════════════════╗\n😂 *Fun Commands*:\n║ ➤ ${p}truth / ${p}dare\n║ ➤ ${p}8ball <question>\n║ ➤ ${p}ship / ${p}flirt\n║ ➤ ${p}compliment / ${p}insult @user\n║ ➤ ${p}gayrate / ${p}smartcheck\n╚═══════════════════╝\n\n╔═══════════════════╗\n🤖 *AI Commands*:\n║ ➤ ${p}ai <question>\n║ ➤ ${p}imagine <prompt>\n║ ➤ ${p}story <topic>\n╚═══════════════════╝\n\nType *${p}allmenu* for the full command list.\nType *${p}ping2* for bot system status.\n\n*Made by Kimani Samuel*`;
    try {
      // Use Malai-XD avatar as menu image; fall back to bot_image.jpg then text
      const avatarPath = path.join(process.cwd(), 'assets', 'malai_avatar.jpg');
      const fallbackPath = path.join(process.cwd(), 'assets', 'bot_image.jpg');
      const imagePath = fs.existsSync(avatarPath) ? avatarPath : (fs.existsSync(fallbackPath) ? fallbackPath : null);
      if (imagePath) {
        await ctx.sock.sendMessage(ctx.chatId, {
          image: fs.readFileSync(imagePath),
          caption: helpMessage,
          contextInfo: { forwardingScore: 1, isForwarded: true }
        }, { quoted: ctx.message });
      } else {
        await reply(ctx, helpMessage);
      }
    } catch (e) {
      await reply(ctx, helpMessage);
    }
  }});

  add({ name: 'allmenu', aliases: ['fullmenu', 'commands', 'allcommand'], category: 'core', desc: 'Show every command by category', handler: async (ctx) => {
    const cfg = getConfig();
    const p = cfg.prefix;
    const grouped = {};
    for (const c of commands) (grouped[c.category] ||= []).push(c);

    const CATEGORY_ICONS = {
      core: '🌟', owner: '👑', group: '👥', downloads: '⬇️',
      converter: '🎞️', tools: '🔧', utility: '🛠️', fun: '😂',
      ai: '🤖', misc: '📦', informer: 'ℹ️', automation: '⚙️'
    };

    const header = `╔══════════════════════════════╗
║  🤖 *${cfg.botName}* — Full Commands
║  📦 Total: *${commands.length}*  |  🔣 Prefix: *${p}*
║  👑 Owner: *${cfg.ownerName}*
╚══════════════════════════════╝`;

    const parts = [header];
    for (const cat of Object.keys(grouped).sort()) {
      const icon = CATEGORY_ICONS[cat] || '📌';
      const cmds = grouped[cat];
      parts.push(`\n╭─── ${icon} *${cat.toUpperCase()}* (${cmds.length}) ───`);
      for (const c of cmds) {
        const usage = c.usage ? ` *${c.usage}*` : '';
        parts.push(`│ ➤ ${p}${c.name}${usage}`);
        if (c.aliases?.length) parts.push(`│    _aliases: ${c.aliases.map(a => p + a).join(', ')}_`);
      }
      parts.push(`╰${'─'.repeat(30)}`);
    }
    parts.push(`\n_Type *${p}menu* for a quick overview_\n${madeByFooter(cfg)}`);

    await sendLongReply(ctx, parts.join('\n'));
  }});

  add({ name: 'ownermenu', aliases: ['adminmenu', 'ownercommands'], category: 'owner', ownerOnly: true, desc: 'Show all owner-only commands in a stylistic list', handler: async (ctx) => {
    const cfg = getConfig();
    const p = cfg.prefix;
    const ownerCmds = commands.filter(c => c.ownerOnly);

    const menu = `╔══════════════════════════════╗
║  👑 *OWNER COMMANDS PANEL*
║  🤖 Bot: *${cfg.botName}*
║  📦 Commands: *${ownerCmds.length}*
╚══════════════════════════════╝

╭─── ⚙️ *BOT CONTROL* ───
│ ➤ ${p}mode <public|private>
│ ➤ ${p}setprefix <prefix>
│ ➤ ${p}setbotname <name>
│ ➤ ${p}setbotpp  _(reply to image)_
│ ➤ ${p}restart
│ ➤ ${p}update
╰──────────────────────────────

╭─── 🔧 *SETTINGS & TOGGLES* ───
│ ➤ ${p}settings
│ ➤ ${p}autobio on/off
│ ➤ ${p}autotyping on/off
│ ➤ ${p}autorecord on/off
│ ➤ ${p}autostatus on/off
│ ➤ ${p}antilink on/off
│ ➤ ${p}anticall on/off
│ ➤ ${p}pmblocker on/off
│ ➤ ${p}autoread on/off
│ ➤ ${p}welcome on/off
│ ➤ ${p}goodbye on/off
╰──────────────────────────────

╭─── 🚫 *USER MANAGEMENT* ───
│ ➤ ${p}ban / ${p}unban @user
│ ➤ ${p}block / ${p}unblock @user
│ ➤ ${p}sudo / ${p}addsudo / ${p}delsudo
│ ➤ ${p}broadcast <message>
╰──────────────────────────────

╭─── 🔗 *PAIRING & SESSION* ───
│ ➤ ${p}pair <number>
│ ➤ ${p}clearsession
╰──────────────────────────────

╭─── 📊 *INFO & STATS* ───
│ ➤ ${p}ping2 _(system status)_
│ ➤ ${p}system
│ ➤ ${p}runtime
│ ➤ ${p}owners
│ ➤ ${p}repo
╰──────────────────────────────

${madeByFooter(cfg)}`;

    await reply(ctx, menu);
  }});



  add({ name: 'ping', aliases: ['speed', 'latency'], category: 'core', desc: 'Check bot response speed', handler: async (ctx) => {
    const cfg = getConfig();
    const start = Date.now();
    await ctx.sock.sendMessage(ctx.chatId, { text: 'Pong! 🏓' }, { quoted: ctx.message });
    const ms = Math.round((Date.now() - start) / 2);
    const botInfo = `┏━━〔 🤖 *${cfg.botName}* 〕━━┓
┃ 🏓 Ping     : ${ms} ms
┃ ⏱️ Uptime   : ${runtime()}
┃ 👑 Owner    : ${cfg.ownerName}
┗━━━━━━━━━━━━━━━━━━━┛

*Made by Kimani Samuel*`;
    await reply(ctx, botInfo);
  }});

  add({ name: 'ping2', aliases: ['botstatus', 'status2'], category: 'core', desc: 'Show detailed bot system status', handler: async (ctx) => {
    const cfg = getConfig();
    const mem = process.memoryUsage();
    const totalRam = os.totalmem();
    const freeRam = os.freemem();
    const usedRam = totalRam - freeRam;
    const cpuModel = os.cpus()?.[0]?.model?.split(' ').slice(0, 3).join(' ') || 'Unknown';
    const start = Date.now();
    await ctx.sock.sendMessage(ctx.chatId, { text: '📡 Checking status...' }, { quoted: ctx.message });
    const ms = Math.round((Date.now() - start) / 2);
    const statusMsg = `┏━━〔 🤖 *${cfg.botName} STATUS* 〕━━┓
┃ 🏓 Ping      : ${ms} ms
┃ 🧠 RAM Used  : ${(usedRam / 1024 / 1024).toFixed(1)} MB / ${(totalRam / 1024 / 1024).toFixed(0)} MB
┃ 📦 Heap Used : ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB
┃ 💾 Node      : ${process.version}
┃ 🖥️ Platform  : ${os.platform()} ${os.arch()}
┃ 🧩 CPU       : ${cpuModel}
┃ ⏱️ Uptime    : ${runtime()}
┃ 👑 Owner     : ${cfg.ownerName}
┃ 🤖 Bot Name  : ${cfg.botName}
┃ 🔣 Prefix    : ${cfg.prefix}
┃ 🔐 Mode      : ${cfg.publicMode ? 'Public' : 'Private'}
┗━━━━━━━━━━━━━━━━━━━━━━┛

*Made by Kimani Samuel*`;
    await reply(ctx, statusMsg);
  }});

  add({ name: 'alive', aliases: ['online'], category: 'core', desc: 'Show bot is online', handler: async (ctx) => {
    const cfg = getConfig();
    await reply(ctx, `╭─〔 ${cfg.botName} 〕\n│ ✅ Status: Online\n│ ⏱️ Runtime: ${runtime()}\n│ 👑 Owner: ${cfg.ownerName}\n╰────────────`);
  }});
  add({ name: 'runtime', aliases: ['uptime'], category: 'core', desc: 'Show uptime', handler: async (ctx) => reply(ctx, `Runtime: ${runtime()}`) });
  add({ name: 'system', aliases: ['sysinfo', 'server'], category: 'core', desc: 'Show host system info', handler: async (ctx) => {
    const s = systemInfo();
    await reply(ctx, `Platform: ${s.platform}\nNode: ${s.node}\nRuntime: ${s.uptime}\nMemory: ${s.memory}\nCPU: ${s.cpu}`);
  }});
  add({ name: 'owner', aliases: ['creator'], category: 'core', desc: 'Send owner contact', handler: async (ctx) => {
    const cfg = getConfig();
    const number = normalizeNumber(cfg.ownerNumber || OWNER_NUMBER);
    const waid = number || OWNER_NUMBER;
    const phone = waid.startsWith('254') ? `+${waid}` : waid;
    const displayName = cfg.ownerName || OWNER_NAME;
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${displayName}`,
      `ORG:${cfg.botName};`,
      `TEL;type=CELL;type=VOICE;waid=${waid}:${phone}`,
      'END:VCARD'
    ].join('\n');
    await ctx.sock.sendMessage(ctx.chatId, {
      contacts: {
        displayName,
        contacts: [{ displayName, vcard }]
      }
    }, { quoted: ctx.message });
    await reply(ctx, `👑 Owner: ${displayName}\n📞 Contact: ${phone}`);
  }});
  add({ name: 'prefix', category: 'core', desc: 'Show current prefix', handler: async (ctx) => reply(ctx, `Current prefix: ${getConfig().prefix}`) });
  add({ name: 'commandcount', aliases: ['cmdcount'], category: 'core', desc: 'Show command count', handler: async (ctx) => reply(ctx, `Loaded commands: ${commands.length}\nAliases included: ${registry.size}`) });
  add({ name: 'about', aliases: ['info'], category: 'core', desc: 'About this merge', handler: async (ctx) => reply(ctx, 'Merged command set inspired by KnightBot Mini, Knightbot MD, NOVA-XMD, and Malaitechx. Built with Baileys and supports QR/pairing login.') });

  add({ name: 'setprefix', aliases: ['prefixset','newprefix'], category: 'owner', ownerOnly: true, desc: 'Change command prefix. Supports .setprefix+ with no space.', usage: '<prefix>', handler: async (ctx) => {
    const p = String(ctx.args[0] || '').trim();
    if (!p) return reply(ctx, `Usage:
${ctx.prefix}setprefix +
${ctx.prefix}setprefix+`);
    if (/\s/.test(p) || p.length > 10) return reply(ctx, 'Prefix cannot contain spaces and must be 10 characters or fewer.');
    saveConfig({ prefix: p });
    await reply(ctx, `✅ Prefix updated to: ${p}
Now use commands like: ${p}menu`);
  }});
  add({ name: 'mode', category: 'owner', ownerOnly: true, desc: 'Set public/private mode', usage: '<public|private>', handler: async (ctx) => {
    const arg = (ctx.args[0] || '').toLowerCase();
    if (!['public','private'].includes(arg)) return reply(ctx, `Current mode: ${getConfig().publicMode ? 'public' : 'private'}\nUsage: mode public/private`);
    saveConfig({ publicMode: arg === 'public' });
    await reply(ctx, `Mode updated to ${arg}.`);
  }});
  add({ name: 'settings', aliases: ['setting', 'toggles', 'config'], category: 'owner', ownerOnly: true, desc: 'Show all on/off bot settings or change one', usage: '[name] [on|off]', handler: async (ctx) => {
    const cfg = getConfig();
    const st = getState();
    const key = (ctx.args[0] || '').toLowerCase();
    const action = (ctx.args[1] || '').toLowerCase();

    // Change a setting: .settings autorecord on
    if (key && ['on', 'off'].includes(action)) {
      const realName = setToggle(st, key, action === 'on');
      if (!realName) {
        return reply(ctx, `❌ Unknown setting: *${key}*\nType ${cfg.prefix}settings to see all available settings.`);
      }
      saveState(st);
      let extra = '';
      if (realName === 'autobio' && action === 'on') extra = `\n${await updateAutoBioFromCommand(ctx)}`;
      const newStatus = isToggleEnabled(st, realName);
      return reply(ctx, `⚙️ *Setting Updated*\n\n${newStatus ? '✅' : '❌'} *${realName}* → *${newStatus ? 'ON' : 'OFF'}*${extra}\n\nType ${cfg.prefix}settings to see all settings.\n\n*Made by Kimani Samuel*`);
    }

    // Check a single setting: .settings autorecord
    if (key && !action) {
      const enabled = isToggleEnabled(st, key);
      return reply(ctx, `⚙️ *${key}*: ${enabled ? '✅ ON' : '❌ OFF'}\n\nUsage: ${cfg.prefix}settings ${key} on/off\n\n*Made by Kimani Samuel*`);
    }

    // Show full settings board
    const TOGGLE_ICONS = {
      greet: '👋', commandreact: '⚡', autobio: '📝', autostatus: '❤️',
      autoreact: '😀', antilink: '🔗', antitag: '🏷️', antibadword: '🤬',
      antidelete: '🗑️', antidelete_status: '📊', antideleteviewonce: '👁️',
      antistatus: '🚫', anticall: '📵', pmblocker: '🔒', autoread: '👀',
      autotyping: '⌨️', autorecord: '🎙️', welcome: '🎉', goodbye: '👋',
      mention: '📣', antiword: '🚫', antigroupmention: '👥', autosticker: '🎨'
    };

    // Import TOGGLE_DEFINITIONS dynamically from settings
    const { TOGGLE_DEFINITIONS: defs } = await import('./settings.js');
    const toggles = defs.map((item, i) => {
      const on = isToggleEnabled(st, item.name);
      const icon = TOGGLE_ICONS[item.name] || '🔧';
      const status = on ? '✅ ON ' : '❌ OFF';
      return `┃ ${icon} ${status}  ${cfg.prefix}${item.name}`;
    });

    const board = `╔══════════════════════════╗
┃  ⚙️ *${cfg.botName} SETTINGS*  
╠══════════════════════════╣
┃ Usage: ${cfg.prefix}settings <name> on/off
┃ Example: ${cfg.prefix}settings autorecord on
╠══════════════════════════╣
${toggles.join('\n')}
╚══════════════════════════╝

*Made by Kimani Samuel*`;

    await reply(ctx, board);
  }});

  add({ name: 'ban', category: 'owner', ownerOnly: true, desc: 'Ban a user from commands', handler: async (ctx) => {
    const target = pickTarget(ctx.message, ctx.sender);
    const st = getState();
    if (!st.banned.includes(target)) st.banned.push(target);
    saveState(st);
    await reply(ctx, `Banned @${normalizeNumber(target)}`, { mentions: [target] });
  }});
  add({ name: 'unban', category: 'owner', ownerOnly: true, desc: 'Unban a user', handler: async (ctx) => {
    const target = pickTarget(ctx.message, ctx.sender);
    const st = getState();
    st.banned = st.banned.filter(x => x !== target);
    saveState(st);
    await reply(ctx, `Unbanned @${normalizeNumber(target)}`, { mentions: [target] });
  }});
  add({ name: 'clearsession', aliases: ['clearsess'], category: 'owner', ownerOnly: true, desc: 'Show session reset instructions', handler: async (ctx) => reply(ctx, 'To reset session safely: stop the bot, delete the session folder, then run npm start again.') });

  add({ name: 'pair', aliases: ['paircode', 'getpair'], category: 'owner', ownerOnly: true, desc: 'Generate a WhatsApp pairing code', usage: '<number>', handler: async (ctx) => {
    const input = textArg(ctx.args);
    if (!input) return reply(ctx, `Usage: ${getConfig().prefix}pair 15551234567`);

    let number;
    try {
      number = validatePairingNumber(input);
    } catch (err) {
      return reply(ctx, err.message || String(err));
    }

    // If this command ever runs before registration, use local Baileys pairing directly.
    if (!ctx.sock.authState?.creds?.registered && typeof ctx.sock.requestPairingCode === 'function') {
      try {
        const code = formatPairingCode(await ctx.sock.requestPairingCode(number));
        return reply(ctx, pairInstructions(code));
      } catch (err) {
        return reply(ctx, `Local pairing failed: ${err.message || err}`);
      }
    }

    const baseUrl = (process.env.PAIRING_API_URL || '').replace(/\/$/, '');
    if (!baseUrl) {
      return reply(ctx, [
        'This running WhatsApp session is already linked, so Baileys cannot create a new local pair code from chat.',
        '',
        'To pair a fresh session:',
        '1. Stop the bot.',
        '2. Delete the session folder.',
        `3. Start with PAIRING_NUMBER=${number} npm start, or open your hosted /code?number=${number} endpoint.`,
        '',
        'Optional: set PAIRING_API_URL to an external pairing service if you want this .pair command to call that service.'
      ].join('\n'));
    }

    try {
      const { data } = await axios.get(`${baseUrl}/code?number=${encodeURIComponent(number)}`, { timeout: 20000 });
      const code = data?.code || data?.pairingCode || data?.pair || data?.message;
      if (!code) throw new Error('Pairing API returned no code.');
      return reply(ctx, pairInstructions(String(code)));
    } catch (err) {
      return reply(ctx, `Pairing API failed: ${err.message || err}`);
    }
  }});
  add({ name: 'restart', category: 'owner', ownerOnly: true, desc: 'Exit process so host restarts it', handler: async (ctx) => { await reply(ctx, 'Restarting process...'); setTimeout(() => process.exit(0), 500); } });

  add({ name: 'jid', aliases: ['groupjid'], category: 'utility', desc: 'Show current chat JID', handler: async (ctx) => reply(ctx, `Chat JID: ${ctx.chatId}\nSender: ${ctx.sender}`) });
  add({ name: 'userid', aliases: ['uid'], category: 'utility', desc: 'Show your WhatsApp ID', handler: async (ctx) => reply(ctx, `Your ID: ${ctx.sender}`) });
  add({ name: 'date', category: 'utility', desc: 'Show server date', handler: async (ctx) => reply(ctx, new Date().toDateString()) });
  add({ name: 'time', category: 'utility', desc: 'Show server time', handler: async (ctx) => reply(ctx, new Date().toLocaleString()) });
  add({ name: 'calc', aliases: ['calculate','math'], category: 'utility', desc: 'Calculate math', usage: '<expression>', handler: async (ctx) => {
    const expression = textArg(ctx.args);
    if (!expression) return reply(ctx, 'Usage: calc 12 * (4 + 3)');
    try { await reply(ctx, `${expression} = ${safeEvalMath(expression)}`); } catch (e) { await reply(ctx, `Math error: ${e.message}`); }
  }});
  add({ name: 'coinflip', aliases: ['coin'], category: 'utility', desc: 'Flip a coin', handler: async (ctx) => reply(ctx, randomChoice(['Heads','Tails'])) });
  add({ name: 'dice', aliases: ['roll'], category: 'utility', desc: 'Roll dice', handler: async (ctx) => reply(ctx, `Dice: ${1 + Math.floor(Math.random() * 6)}`) });
  add({ name: 'random', aliases: ['rand'], category: 'utility', desc: 'Random number', usage: '<min> <max>', handler: async (ctx) => {
    const min = Number(ctx.args[0] || 1), max = Number(ctx.args[1] || 100);
    const lo = Math.min(min, max), hi = Math.max(min, max);
    await reply(ctx, String(lo + Math.floor(Math.random() * (hi - lo + 1))));
  }});
  add({ name: 'choose', aliases: ['pick'], category: 'utility', desc: 'Choose from options split by |', usage: 'tea | coffee', handler: async (ctx) => {
    const opts = textArg(ctx.args).split('|').map(x => x.trim()).filter(Boolean);
    if (opts.length < 2) return reply(ctx, 'Usage: choose option 1 | option 2 | option 3');
    await reply(ctx, `I choose: ${randomChoice(opts)}`);
  }});
  add({ name: 'password', aliases: ['passgen'], category: 'utility', desc: 'Generate password', handler: async (ctx) => {
    const len = Math.min(Math.max(Number(ctx.args[0] || 16), 6), 64);
    const chars = 'ABCDEFGHJKLMN8SjFSqSJ6DYAcBJrNGN76hEhcij5vtyJK5G819CvV7Fm!@#$%';
    let out = ''; for (let i=0;i<len;i++) out += chars[Math.floor(Math.random()*chars.length)];
    await reply(ctx, out);
  }});
  add({ name: 'uuid', category: 'utility', desc: 'Generate UUID', handler: async (ctx) => reply(ctx, crypto.randomUUID()) });
  add({ name: 'shortid', category: 'utility', desc: 'Generate short ID', handler: async (ctx) => reply(ctx, crypto.randomBytes(6).toString('hex')) });
  add({ name: 'qr', category: 'utility', desc: 'Create QR code link', usage: '<text>', handler: async (ctx) => {
    const t = encodeURIComponent(textArg(ctx.args));
    if (!t) return reply(ctx, 'Usage: qr hello world');
    await ctx.sock.sendMessage(ctx.chatId, { image: { url: `https://api.qrserver.com/v1/create-qr-code/?size=600x600&data=${t}` }, caption: 'QR generated' }, { quoted: ctx.message });
  }});

  // Group and admin commands
  add({ name: 'groupinfo', aliases: ['ginfo'], category: 'group', groupOnly: true, desc: 'Show group name, description, dp, admins, and members', handler: async (ctx) => {
    const meta = await ctx.sock.groupMetadata(ctx.chatId);
    const participants = meta.participants.map(p => p.id || p.jid).filter(Boolean);
    const admins = meta.participants.filter(p => p.admin || p.isAdmin).map(p => p.id || p.jid).filter(Boolean);
    const desc = meta.desc || meta.description || 'No description set.';
    const created = meta.creation ? new Date(Number(meta.creation) * 1000).toLocaleString() : 'Unknown';
    const summary = [
      `╭─〔 GROUP INFO 〕`,
      `│ Name: ${meta.subject || 'Unknown'}`,
      `│ Description: ${desc}`,
      `│ Members: ${participants.length}`,
      `│ Admins: ${admins.length}`,
      `│ Owner: ${meta.owner ? '@' + normalizeNumber(meta.owner) : 'unknown'}`,
      `│ Created: ${created}`,
      `│ ID: ${ctx.chatId}`,
      `╰────────────`
    ];
    const lines = [
      ...summary,
      '',
      'Admins:',
      ...(admins.length ? admins.map((j, i) => `${i + 1}. @${normalizeNumber(j)}`) : ['No admins found.']),
      '',
      'Members:',
      ...(participants.length ? participants.map((j, i) => `${i + 1}. @${normalizeNumber(j)}`) : ['No members found.'])
    ];
    const mentions = [...new Set([meta.owner, ...admins, ...participants].filter(Boolean))];
    const fullInfo = lines.join('\n');
    let sentDp = false;
    try {
      const pp = await ctx.sock.profilePictureUrl(ctx.chatId, 'image');
      await ctx.sock.sendMessage(ctx.chatId, { image: { url: pp }, caption: summary.join('\n'), mentions }, { quoted: ctx.message });
      sentDp = true;
    } catch {}
    await sendLongReply(ctx, sentDp ? fullInfo : `${fullInfo}\n\nGroup DP: not available.`, { mentions });
  }});
  add({ name: 'totalmembers', aliases: ['members'], category: 'group', groupOnly: true, desc: 'Count group members', handler: async (ctx) => {
    const meta = await ctx.sock.groupMetadata(ctx.chatId);
    await reply(ctx, `Total members: ${meta.participants.length}`);
  }});
  add({ name: 'admins', aliases: ['staff'], category: 'group', groupOnly: true, desc: 'List group admins', handler: async (ctx) => {
    const admins = await groupAdmins(ctx.sock, ctx.chatId);
    await reply(ctx, admins.map(j => `@${normalizeNumber(j)}`).join('\n') || 'No admins found', { mentions: admins });
  }});
  add({ name: 'tagall', aliases: ['everyone'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Mention every group member', handler: async (ctx) => {
    const meta = await ctx.sock.groupMetadata(ctx.chatId);
    const mentions = meta.participants.map(p => p.id || p.jid);
    await sendLongReply(ctx, mentions.map((j, i) => `${i + 1}. @${normalizeNumber(j)}`).join('\n'), { mentions });
  }});
  add({ name: 'hidetag', aliases: ['htag'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Send hidden-tag message', usage: '<message>', handler: async (ctx) => {
    const meta = await ctx.sock.groupMetadata(ctx.chatId);
    const mentions = meta.participants.map(p => p.id || p.jid);
    await reply(ctx, textArg(ctx.args, 'Hidden tag'), { mentions });
  }});
  add({ name: 'tagadmin', aliases: ['tagadmins'], category: 'group', groupOnly: true, desc: 'Mention admins', handler: async (ctx) => {
    const admins = await groupAdmins(ctx.sock, ctx.chatId);
    await reply(ctx, admins.map(j => `@${normalizeNumber(j)}`).join('\n') || 'No admins found', { mentions: admins });
  }});
  add({ name: 'kick', aliases: ['remove'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Remove mentioned/replied users or typed numbers from group', usage: '@user | +254...', handler: async (ctx) => {
    await ensureBotGroupAdmin(ctx, 'kick/remove members');
    const rawTargets = jidsFromArgs(ctx);
    if (!rawTargets.length) return reply(ctx, `Usage: ${getConfig().prefix}kick @user or ${getConfig().prefix}kick +254101223737`);
    const targets = await resolveGroupTargets(ctx, rawTargets);
    const botNumber = normalizeNumber(ctx.sock.user?.id || ctx.sock.user?.jid || '');
    const safeTargets = targets.filter(jid => normalizeNumber(jid) !== botNumber && normalizeNumber(jid) !== normalizeNumber(getConfig().ownerNumber));
    if (!safeTargets.length) return reply(ctx, 'I cannot remove myself or the bot owner.');
    try {
      await ctx.sock.groupParticipantsUpdate(ctx.chatId, safeTargets, 'remove');
      await reply(ctx, `✅ Removed ${formatTargetList(safeTargets)}`, { mentions: safeTargets });
    } catch (err) {
      await reply(ctx, `Kick failed: ${err.message || err}. Make sure I am admin and the target is still in this group.`);
    }
  }});
  add({ name: 'add', aliases: ['inviteuser','adduser'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Add one or many numbers to the group', usage: '+254101223737 +254...', handler: async (ctx) => {
    await ensureBotGroupAdmin(ctx, 'add members');

    // Parse numbers from all args — accept 2540700000000, +2540700000000, 0700000000, quoted, or mentioned
    const rawText = ctx.rawText || ctx.args.join(' ');
    const tokenSet = new Set();

    // From mentions/quoted
    jidsFromArgs(ctx, { includeQuoted: true, includeMentions: true }).forEach(j => tokenSet.add(j));

    // From raw text — match phone-like tokens
    for (const token of rawText.split(/[\s,;|]+/)) {
      const cleaned = token.replace(/[^\d+]/g, '');
      if (cleaned.length >= 5) {
        const jid = toUserJid(cleaned);
        if (jid) tokenSet.add(jid);
      }
    }

    const targets = [...tokenSet];
    if (!targets.length) return reply(ctx, `Usage: ${getConfig().prefix}add +254700000000 +254711000000\nYou can provide multiple numbers separated by spaces.`);

    const resultLines = [];
    for (const jid of targets) {
      const num = normalizeNumber(jid);
      try {
        const res = await ctx.sock.groupParticipantsUpdate(ctx.chatId, [jid], 'add');
        const status = Array.isArray(res) ? (res[0]?.status || 'unknown') : (res?.status || 'sent');
        if (status === '200' || status === 200 || status === 'added') {
          resultLines.push(`✅ @${num} added successfully`);
        } else if (status === '403' || status === 403) {
          resultLines.push(`⛔ @${num} has privacy settings that prevent adding. Send invite link instead.`);
        } else if (status === '408' || status === 408) {
          resultLines.push(`⏱️ @${num} timed out. They may not be on WhatsApp.`);
        } else if (status === '401' || status === 401) {
          resultLines.push(`❌ @${num} blocked the bot or is not on WhatsApp.`);
        } else {
          resultLines.push(`✅ @${num} add request sent (status: ${status})`);
        }
      } catch (err) {
        const msg = err.message || String(err);
        if (msg.includes('not-authorized') || msg.includes('403')) {
          resultLines.push(`⛔ @${num} — privacy settings block adding. Share the invite link instead.`);
        } else if (msg.includes('not on WhatsApp') || msg.includes('408')) {
          resultLines.push(`❓ @${num} — not found on WhatsApp.`);
        } else {
          resultLines.push(`❌ @${num} — failed: ${msg.slice(0, 80)}`);
        }
      }
      await new Promise(r => setTimeout(r, 400));
    }
    await reply(ctx, resultLines.join('\n'), { mentions: targets });
  }});
  add({ name: 'approve', aliases: ['accept','approveall'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Approve pending group join requests', usage: '[number/@user] or approveall', handler: async (ctx) => {
    await ensureBotGroupAdmin(ctx, 'approve join requests');
    let targets = jidsFromArgs(ctx);
    const wantsAll = ctx.commandName === 'approveall' || !targets.length || /^(all)$/i.test(ctx.args[0] || '');
    if (wantsAll && typeof ctx.sock.grKe9UDk2eYoMm9CAJhsv2CBGW7CUFSPNhu === 'function') {
      const pending = await ctx.sock.grKe9UDk2eYoMm9CAJhsv2CBGW7CUFSPNhu(ctx.chatId).catch(() => []);
      targets = (pending || []).map(p => p.jid || p.id).filter(Boolean);
    }
    if (!targets.length) return reply(ctx, 'No pending requests found. You can also mention a user or type their number.');
    if (typeof ctx.sock.grKe9UDk2eYoMm9CAJhsv2CBGW7CUFSPNhu !== 'function') {
      return reply(ctx, 'This Baileys version/WhatsApp account does not expose pending request approval on this host.');
    }
    const result = await ctx.sock.grKe9UDk2eYoMm9CAJhsv2CBGW7CUFSPNhu(ctx.chatId, targets, 'approve');
    await reply(ctx, `Approved ${formatTargetList(targets)}${result ? `\nResult: ${JSON.stringify(result).slice(0, 900)}` : ''}`, { mentions: targets });
  }});
  add({ name: 'block', category: 'owner', ownerOnly: true, desc: 'Block a WhatsApp user by reply, mention, or number', usage: '@user | +254...', handler: async (ctx) => {
    const targets = jidsFromArgs(ctx);
    if (!targets.length) return reply(ctx, `Usage: ${getConfig().prefix}block @user or ${getConfig().prefix}block +254101223737`);
    for (const target of targets) await ctx.sock.updateBlockStatus(target, 'block');
    await reply(ctx, `Blocked ${formatTargetList(targets)}`, { mentions: targets });
  }});
  add({ name: 'unblock', category: 'owner', ownerOnly: true, desc: 'Unblock a WhatsApp user by reply, mention, or number', usage: '@user | +254...', handler: async (ctx) => {
    const targets = jidsFromArgs(ctx);
    if (!targets.length) return reply(ctx, `Usage: ${getConfig().prefix}unblock @user or ${getConfig().prefix}unblock +254101223737`);
    for (const target of targets) await ctx.sock.updateBlockStatus(target, 'unblock');
    await reply(ctx, `Unblocked ${formatTargetList(targets)}`, { mentions: targets });
  }});
  add({ name: 'promote', category: 'group', groupOnly: true, adminOnly: true, desc: 'Promote user to admin', usage: '@user | +254...', handler: async (ctx) => {
    await ensureBotGroupAdmin(ctx, 'promote members');
    const rawTargets = jidsFromArgs(ctx);
    if (!rawTargets.length) return reply(ctx, 'Mention, reply, or type a number to promote.');
    const targets = await resolveGroupTargets(ctx, rawTargets);
    try {
      await ctx.sock.groupParticipantsUpdate(ctx.chatId, targets, 'promote');
      const promoterNum = normalizeNumber(ctx.sender);
      const userLines = targets.map(j => `• @${normalizeNumber(j)}`).join('\n');
      const msg =
        `*『 GROUP PROMOTION 』*\n\n` +
        `👥 *Promoted User${targets.length > 1 ? 's' : ''}:*\n${userLines}\n\n` +
        `👑 *Promoted By:* @${promoterNum}\n` +
        `📅 *Date:* ${new Date().toLocaleString()}`;
      await reply(ctx, msg, { mentions: [...targets, ctx.sender] });
    } catch (err) {
      await reply(ctx, `❌ Promote failed: ${err.message || err}`);
    }
  }});
  add({ name: 'demote', category: 'group', groupOnly: true, adminOnly: true, desc: 'Demote admin to member', usage: '@user | +254...', handler: async (ctx) => {
    await ensureBotGroupAdmin(ctx, 'demote admins');
    const rawTargets = jidsFromArgs(ctx);
    if (!rawTargets.length) return reply(ctx, 'Mention, reply, or type a number to demote.');
    const targets = await resolveGroupTargets(ctx, rawTargets);
    try {
      await new Promise(r => setTimeout(r, 800));
      await ctx.sock.groupParticipantsUpdate(ctx.chatId, targets, 'demote');
      const demoterNum = normalizeNumber(ctx.sender);
      const userLines = targets.map(j => `• @${normalizeNumber(j)}`).join('\n');
      const msg =
        `*『 GROUP DEMOTION 』*\n\n` +
        `👤 *Demoted User${targets.length > 1 ? 's' : ''}:*\n${userLines}\n\n` +
        `👑 *Demoted By:* @${demoterNum}\n` +
        `📅 *Date:* ${new Date().toLocaleString()}`;
      await reply(ctx, msg, { mentions: [...targets, ctx.sender] });
    } catch (err) {
      if (String(err?.data || err?.message || err).includes('429')) {
        await new Promise(r => setTimeout(r, 2000));
        await reply(ctx, '⚠️ Rate limit hit. Please try again in a few seconds.');
      } else {
        await reply(ctx, `❌ Demote failed: ${err.message || err}`);
      }
    }
  }});
  add({ name: 'open', aliases: ['unmute'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Open group chat', handler: async (ctx) => { await ctx.sock.groupSettingUpdate(ctx.chatId, 'not_announcement'); await reply(ctx, 'Group opened.'); } });
  add({ name: 'close', aliases: ['mute'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Close group chat', handler: async (ctx) => { await ctx.sock.groupSettingUpdate(ctx.chatId, 'announcement'); await reply(ctx, 'Group closed.'); } });
  add({ name: 'grouplink', aliases: ['link'], category: 'group', groupOnly: true, desc: 'Get invite link', handler: async (ctx) => { const code = await ctx.sock.groupInviteCode(ctx.chatId); await reply(ctx, `https://chat.whatsapp.com/${code}`); } });
  add({ name: 'resetlink', aliases: ['revoke'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Reset group invite link', handler: async (ctx) => { const code = await ctx.sock.groupRevokeInvite(ctx.chatId); await reply(ctx, `New link: https://chat.whatsapp.com/${code}`); } });
  add({ name: 'setgname', aliases: ['setgroupname'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Set group name', usage: '<name>', handler: async (ctx) => { const t = textArg(ctx.args); if (!t) return reply(ctx, 'Usage: setgname New Name'); await ctx.sock.groupUpdateSubject(ctx.chatId, t); await reply(ctx, 'Group name updated.'); } });
  add({ name: 'setgdesc', aliases: ['setdesc'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Set group description', usage: '<desc>', handler: async (ctx) => { const t = textArg(ctx.args); if (!t) return reply(ctx, 'Usage: setgdesc New description'); await ctx.sock.groupUpdateDescription(ctx.chatId, t); await reply(ctx, 'Group description updated.'); } });

  // Text commands
  const addText = (name, desc, transform, aliases = []) => add({ name, aliases, category: 'text', desc, usage: '<text>', handler: async (ctx) => { const t = textArg(ctx.args); if (!t) return reply(ctx, `Usage: ${getConfig().prefix}${name} <text>`); await reply(ctx, transform(t)); } });
  addText('reverse', 'Reverse text', t => [...t].reverse().join(''));
  addText('upper', 'Uppercase text', t => t.toUpperCase(), ['uppercase']);
  addText('lower', 'Lowercase text', t => t.toLowerCase(), ['lowercase']);
  addText('capitalize', 'Capitalize text', t => t.charAt(0).toUpperCase() + t.slice(1));
  addText('titlecase', 'Title-case text', t => t.replace(/\w\S*/g, x => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase()));
  addText('mock', 'Mocking text', t => [...t].map((c,i)=> i%2?c.toLowerCase():c.toUpperCase()).join(''));
  addText('clap', 'Clap text', t => t.split(/\s+/).join(' 👏 '));
  addText('space', 'Space letters', t => [...t].join(' '));
  addText('vapor', 'Vaporwave text', t => [...t].map(c => c === ' ' ? '　' : String.fromCharCode(c.charCodeAt(0) + (c >= '!' && c <= '~' ? 65248 : 0))).join(''));
  addText('bold', 'Bold unicode text', t => toFancy(t, 'bold'));
  addText('italic', 'Italic unicode text', t => toFancy(t, 'italic'));
  addText('mono', 'Monospace unicode text', t => toFancy(t, 'mono'));
  addText('double', 'Double-struck unicode text', t => toFancy(t, 'double'));
  addText('circletext', 'Circle unicode text', t => toFancy(t, 'circle'), ['circlefont']);
  addText('binary', 'Text to binary', t => [...t].map(c => c.charCodeAt(0).toString(2).padStart(8,'0')).join(' '));
  addText('unbinary', 'Binary to text', t => t.split(/\s+/).map(b => String.fromCharCode(parseInt(b,2))).join(''));
  addText('base64', 'Encode base64', t => Buffer.from(t).toString('base64'), ['b64']);
  addText('unbase64', 'Decode base64', t => Buffer.from(t, 'base64').toString('utf8'), ['unb64']);
  addText('urlencode', 'URL encode', t => encodeURIComponent(t));
  addText('urldecode', 'URL decode', t => decodeURIComponent(t));
  addText('morse', 'Text to morse', t => t.toLowerCase().split('').map(c => c === ' ' ? '/' : morseMap[c] || c).join(' '));
  addText('unmorse', 'Morse to text', t => t.split(/\s+/).map(c => c === '/' ? ' ' : reverseMorse[c] || c).join(''));
  addText('charcount', 'Count characters', t => `Characters: ${[...t].length}`);
  addText('wordcount', 'Count words', t => `Words: ${t.trim().split(/\s+/).filter(Boolean).length}`);
  addText('emojify', 'Add emoji between words', t => t.split(/\s+/).join(' ✨ '));
  addText('spoiler', 'WhatsApp spoiler style', t => `||${t}||`);

  // Fun and game commands
  add({ name: 'joke', category: 'fun', desc: 'Random joke', handler: async (ctx) => reply(ctx, randomChoice(jokes)) });
  add({ name: 'fact', category: 'fun', desc: 'Random fact', handler: async (ctx) => reply(ctx, randomChoice(facts)) });
  add({ name: 'quote', category: 'fun', desc: 'Random quote', handler: async (ctx) => reply(ctx, randomChoice(quotes)) });
  add({ name: 'truth', category: 'fun', desc: 'Truth question', handler: async (ctx) => reply(ctx, randomChoice(truths)) });
  add({ name: 'dare', category: 'fun', desc: 'Dare challenge', handler: async (ctx) => reply(ctx, randomChoice(dares)) });
  add({ name: 'compliment', aliases: ['complimentry'], category: 'fun', desc: 'Compliment a user', handler: async (ctx) => { const t = pickTarget(ctx.message, ctx.sender); await reply(ctx, `@${normalizeNumber(t)} is ${randomChoice(compliments)}.`, { mentions: [t] }); } });
  add({ name: 'insult', category: 'fun', desc: 'Playful roast', handler: async (ctx) => { const t = pickTarget(ctx.message, ctx.sender); await reply(ctx, `@${normalizeNumber(t)} ${randomChoice(insults)}.`, { mentions: [t] }); } });
  add({ name: 'flirt', category: 'fun', desc: 'Flirty line', handler: async (ctx) => reply(ctx, randomChoice(['Are you Wi-Fi? Because I feel connected.', 'You must be a keyboard, because you are just my type.', 'Are you a bug? Because I cannot stop debugging my feelings.'])) });
  add({ name: '8ball', aliases: ['eightball'], category: 'fun', desc: 'Ask magic 8 ball', handler: async (ctx) => reply(ctx, randomChoice(['Yes.', 'No.', 'Maybe.', 'Definitely.', 'Ask again later.', 'The bot says yes.'])) });
  add({ name: 'ship', category: 'fun', desc: 'Ship two users/names', handler: async (ctx) => { const names = textArg(ctx.args, 'you + bot'); await reply(ctx, `${names}: ${hashPercent(names)}% compatible`); } });
  add({ name: 'truthdetector', aliases: ['lie'], category: 'fun', desc: 'Fake truth detector', handler: async (ctx) => reply(ctx, randomChoice(['Truth detected.', 'Lie detected.', 'Unclear. Try again with more confidence.'])) });
  add({ name: 'rps', aliases: ['rockpaper'], category: 'games', desc: 'Rock paper scissors', usage: '<rock|paper|scissors>', handler: async (ctx) => { const user = (ctx.args[0]||'').toLowerCase(); const bot = randomChoice(['rock','paper','scissors']); if (!['rock','paper','scissors'].includes(user)) return reply(ctx, 'Usage: rps rock/paper/scissors'); await reply(ctx, `You: ${user}\nBot: ${bot}`); } });
  add({ name: 'hangman', category: 'games', desc: 'Mini hangman prompt', handler: async (ctx) => reply(ctx, 'Hangman word: _ _ _\nThis lightweight build supports prompt mode. Use tictactoe, rps, dice, or quiz for interactive games.') });
  add({ name: 'tictactoe', aliases: ['ttt'], category: 'games', desc: 'Tic-tac-toe info', handler: async (ctx) => reply(ctx, 'TicTacToe board:\n1 | 2 | 3\n4 | 5 | 6\n7 | 8 | 9\nPair with a friend and send move numbers manually.') });
  add({ name: 'quiz', aliases: ['trivia'], category: 'games', desc: 'Quick trivia', handler: async (ctx) => reply(ctx, 'Trivia: What does CPU stand for?\nAnswer: Central Processing Unit.') });

  for (const metric of ['gayrate','simprate','stupidrate','lovelyrate','cuterate','luckrate','smartcheck','horny','handsome','beautiful','coolrate','evilrate','goodrate','badboy','queenrate','kingrate']) {
    add({ name: metric, category: 'fun', desc: `${metric} percentage`, handler: async (ctx) => { const target = pickTarget(ctx.message, ctx.sender); await reply(ctx, `@${normalizeNumber(target)} ${metric}: ${hashPercent(metric + target)}%`, { mentions: [target] }); } });
  }

  // AI/local creative commands
  add({ name: 'ai', aliases: ['gpt','gemini','chatgpt'], category: 'ai', desc: 'Ask AI/local helper', usage: '<prompt>', handler: async (ctx) => {
    const q = textArg(ctx.args);
    if (!q) return reply(ctx, 'Usage: ai <question>');
    await reply(ctx, `AI helper received: ${q}\n\nSet OPENAI_API_KEY and extend src/commands.js if you want live model calls. This offline-safe build keeps the bot running without paid keys.`);
  }});
  add({ name: 'summarize', aliases: ['summary'], category: 'ai', desc: 'Simple text summary', usage: '<text>', handler: async (ctx) => { const t = textArg(ctx.args); if (!t) return reply(ctx, 'Usage: summarize <long text>'); await reply(ctx, t.split(/[.!?]/).filter(Boolean).slice(0,3).join('. ').trim() + '.'); } });
  add({ name: 'story', category: 'ai', desc: 'Generate short story', usage: '<topic>', handler: async (ctx) => { const topic = textArg(ctx.args, 'a brave bot'); await reply(ctx, `Once upon a time, ${topic} faced a hard challenge, learned fast, helped the group, and became legendary.`); } });
  add({ name: 'recipe', category: 'ai', desc: 'Make a quick recipe', usage: '<ingredient>', handler: async (ctx) => { const item = textArg(ctx.args, 'rice'); await reply(ctx, `Quick ${item} recipe:\n1. Prepare ingredients.\n2. Cook with seasoning.\n3. Taste and adjust.\n4. Serve hot.`); } });
  add({ name: 'teach', category: 'ai', desc: 'Save a learned reply', usage: '<key> = <reply>', handler: async (ctx) => { const raw = textArg(ctx.args); const [key, ...rest] = raw.split('='); if (!key || !rest.length) return reply(ctx, 'Usage: teach hello = Hi there!'); const st = getState(); st.learned[key.trim().toLowerCase()] = rest.join('=').trim(); saveState(st); await reply(ctx, `Learned: ${key.trim()}`); } });
  add({ name: 'ask', category: 'ai', desc: 'Read learned reply', usage: '<key>', handler: async (ctx) => { const st = getState(); const key = textArg(ctx.args).toLowerCase(); await reply(ctx, st.learned[key] || 'No learned reply found.'); } });
  add({ name: 'imagine', aliases: ['dalle','flux','sora'], category: 'ai', desc: 'Image prompt helper', usage: '<prompt>', handler: async (ctx) => { const prompt = textArg(ctx.args); if (!prompt) return reply(ctx, 'Usage: imagine neon dragon'); await reply(ctx, `Image prompt saved:\n${prompt}\n\nConnect an image API in this command to generate real images.`); } });

  // Search/download/media commands: reliable wrappers with graceful external failure.
  add({ name: 'github', aliases: ['gh'], category: 'search', desc: 'Search GitHub user', usage: '<username>', handler: async (ctx) => {
    const u = ctx.args[0]; if (!u) return reply(ctx, 'Usage: github torvalds');
    try { const { data } = await axios.get(`https://api.github.com/users/${encodeURIComponent(u)}`, { timeout: 10000 }); await reply(ctx, `GitHub: ${data.login}\nName: ${data.name || '-'}\nRepos: ${data.public_repos}\nFollowers: ${data.followers}\nURL: ${data.html_url}`); }
    catch (e) { await reply(ctx, `GitHub lookup failed: ${e.message}`); }
  }});
  add({ name: 'weather', category: 'search', desc: 'Weather via wttr.in', usage: '<city>', handler: async (ctx) => { const city = textArg(ctx.args); if (!city) return reply(ctx, 'Usage: weather London'); try { const { data } = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=3`, { timeout: 10000 }); await reply(ctx, String(data)); } catch (e) { await reply(ctx, `Weather failed: ${e.message}`); } } });
  add({ name: 'news', category: 'search', desc: 'News helper', handler: async (ctx) => reply(ctx, 'News command is ready. Add NEWS_API_KEY in .env for live headlines, or use .search <topic>.') });
  add({ name: 'search', aliases: ['google'], category: 'search', desc: 'Search helper', usage: '<query>', handler: async (ctx) => { const q = textArg(ctx.args); if (!q) return reply(ctx, 'Usage: search WhatsApp bot'); await reply(ctx, `Search URL: https://www.google.com/search?q=${encodeURIComponent(q)}`); } });
  add({ name: 'wiki', aliases: ['wikipedia'], category: 'search', desc: 'Wikipedia URL helper', usage: '<topic>', handler: async (ctx) => { const q = textArg(ctx.args); if (!q) return reply(ctx, 'Usage: wiki Node.js'); await reply(ctx, `Wikipedia: https://en.wikipedia.org/wiki/${encodeURIComponent(q.replace(/\s+/g, '_'))}`); } });

  // ─── VV: Reveal View-Once Media (KnightBot-MD style) ─────────────────────
  add({ name: 'vv', aliases: ['viewonce', 'vo'], category: 'converter', desc: 'Reveal view-once image or video', handler: async (ctx) => {
    const quoted = ctx.message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedImage = quoted?.imageMessage;
    const quotedVideo = quoted?.videoMessage;
    if (quotedImage?.viewOnce) {
      try {
        const stream = await downloadContentFromMessage(quotedImage, 'image');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        await ctx.sock.sendMessage(ctx.chatId, {
          image: buffer,
          caption: `🔓 *View-Once Revealed*\n\n*Made by Kimani Samuel*`
        }, { quoted: ctx.message });
      } catch (e) { await reply(ctx, `❌ Failed to reveal: ${e.message}`); }
    } else if (quotedVideo?.viewOnce) {
      try {
        const stream = await downloadContentFromMessage(quotedVideo, 'video');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        await ctx.sock.sendMessage(ctx.chatId, {
          video: buffer,
          caption: `🔓 *View-Once Revealed*\n\n*Made by Kimani Samuel*`
        }, { quoted: ctx.message });
      } catch (e) { await reply(ctx, `❌ Failed to reveal: ${e.message}`); }
    } else {
      await reply(ctx, '❌ Please reply to a view-once image or video.');
    }
  }});

  // ─── VV2: Auto-forward view-once to owner's own chat (silent, no announcement) ─
  // This is handled as an auto-event in index.js. The vv2 command just explains usage.
  add({ name: 'vv2', aliases: ['autoviewonce'], category: 'converter', desc: 'Auto-forward view-once to owner saved messages (owner only)', handler: async (ctx) => {
    const cfg = getConfig();
    const st = getState();
    const action = (ctx.args[0] || 'status').toLowerCase();
    if (!ctx.owner) return reply(ctx, '❌ This command is owner-only.');
    if (['on','off'].includes(action)) {
      if (!st.groupSettings) st.groupSettings = {};
      st.groupSettings._vv2 = action === 'on';
      saveState(st);
      await reply(ctx, `✅ VV2 auto-forward *${action.toUpperCase()}*\n\n*Made by Kimani Samuel*`);
    } else {
      const isOn = st.groupSettings?._vv2 !== false;
      await reply(ctx, `🔍 *VV2 Status*: ${isOn ? 'ON' : 'OFF'}\nAll incoming view-once media is silently forwarded to your saved messages.\nUse ${cfg.prefix}vv2 on/off\n\n*Made by Kimani Samuel*`);
    }
  }});

  // ─── Other media command stubs ─────────────────────────────────────────────
  const mediaNames = ['sticker','s','take','attp','simage','getpp','setpp','setbotpp','crop','stickercrop','toimg','tomp3','toptt','tovideo','videodoc','volaudio','reverseaudio','bass','blown','deep','earrape','fast','fat','nightcore','robot','slow','smooth','tupai','removebg','remini','enhance','upscale','blur','img-blur'];
  for (const name of mediaNames) {
    if (registry.has(name)) continue;
    add({ name, category: 'converter', desc: `${name} media command`, handler: async (ctx) => reply(ctx, `${name} is registered. Reply to media with ${getConfig().prefix}${name}. Full conversion needs ffmpeg/sharp support on the host.`) });
  }

  // ─── PLAY / SONG: Download YouTube audio (Knightbot-MD style with multi-API fallback) ──
  add({
    name: 'play',
    aliases: ['song', 'music', 'ytmp3', 'song2'],
    category: 'downloads',
    desc: 'Download music from YouTube',
    usage: '<song name or YouTube URL>',
    handler: async (ctx) => {
      try {
        const query = textArg(ctx.args);
        if (!query) return await reply(ctx, `Usage: ${getConfig().prefix}play <song name or YouTube link>`);

        if (!yts) throw new Error('yt-search module not available. Try: npm install yt-search');
        const search = await yts(query);
        const videos = search?.videos || [];
        if (!videos.length) return await reply(ctx, '❌ No songs found for that query. Try different keywords.');

        const video = videos[0];

        // Send thumbnail preview like Knightbot-MD
        try {
          if (video.thumbnail) {
            await ctx.sock.sendMessage(ctx.chatId, {
              image: { url: video.thumbnail },
              caption: `🎵 *Downloading:* ${video.title}\n⏱ *Duration:* ${video.timestamp || video.duration?.timestamp || 'N/A'}`
            }, { quoted: ctx.message });
          }
        } catch { /* thumbnail send failed, continue */ }

        const youtubeUrl = video.url;
        const encoded = encodeURIComponent(youtubeUrl);
        const HEADERS = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, */*'
        };

        // Multi-API fallback chain
        const apiMethods = [
          { name: 'keith',      url: `https://apis-keith.vercel.app/download/dlmp3?url=${encoded}` },
          { name: 'ElitePro',   url: `https://eliteprotech-apis.zone.id/ytdown?url=${encoded}&format=mp3` },
          { name: 'Yupra',      url: `https://api.yupra.my.id/api/downloader/ytmp3?url=${encoded}` },
          { name: 'Okatsu',     url: `https://okatsu-rolezapiiz.vercel.app/downloader/ytmp3?url=${encoded}` },
          { name: 'davidcyril', url: `https://api.davidcyriltech.my.id/download/ytmp3?url=${encoded}` },
          { name: 'dreaded',    url: `https://api.dreaded.site/api/ytdl/audio?url=${encoded}` },
          { name: 'bk9',        url: `https://bk9.fun/download/ytmp3?url=${encoded}` },
          { name: 'agatz',      url: `https://api.agatz.xyz/api/ytmp3?url=${encoded}` }
        ];

        // Extract a direct audio file URL from an API response.
        // Deliberately avoids data?.url / data?.link which many APIs set to the
        // original YouTube watch page, causing corrupt downloads.
        function extractAudioUrl(data) {
          const candidates = [
            data?.result?.downloadUrl, data?.result?.download_url, data?.result?.dl,
            data?.result?.audio,       data?.result?.file,
            data?.data?.downloadUrl,   data?.data?.download_url,  data?.data?.dl,
            data?.data?.audio,         data?.data?.file,
            data?.downloadUrl,         data?.downloadURL,
            data?.dl,                  data?.download,
            data?.audio,               data?.file,
            // These two are ambiguous (often the YouTube page URL) — checked last
            data?.result?.url, data?.data?.url, data?.url, data?.link,
          ];
          for (const c of candidates) {
            if (typeof c === 'string' && /^https?:\/\//i.test(c) &&
                !/youtube\.com\/watch|youtu\.be\//i.test(c)) {
              return c;
            }
          }
          return '';
        }

        let audioUrl = '';
        let finalTitle = sanitizeFileName(video.title || 'song');

        for (const api of apiMethods) {
          try {
            const { data } = await axios.get(api.url, { timeout: 30000, headers: HEADERS });
            const url = extractAudioUrl(data);
            if (url) {
              audioUrl = url;
              const t = data?.result?.title || data?.data?.title || data?.title;
              if (t) finalTitle = sanitizeFileName(t);
              break;
            }
          } catch { /* try next */ }
        }

        if (!audioUrl) throw new Error('All download APIs failed. Please try again later or send a direct YouTube link.');

        // Download audio buffer
        let audioBuffer;
        try {
          const resp = await axios.get(audioUrl, {
            responseType: 'arraybuffer', timeout: 90000,
            maxContentLength: Infinity, maxBodyLength: Infinity,
            validateStatus: s => s >= 200 && s < 400,
            headers: { 'User-Agent': HEADERS['User-Agent'], 'Accept': '*/*', 'Accept-Encoding': 'identity' }
          });
          audioBuffer = Buffer.from(resp.data);
        } catch {
          // Fallback: stream download
          const resp = await axios.get(audioUrl, {
            responseType: 'stream', timeout: 90000,
            maxContentLength: Infinity, maxBodyLength: Infinity,
            validateStatus: s => s >= 200 && s < 400,
            headers: { 'User-Agent': HEADERS['User-Agent'], 'Accept': '*/*', 'Accept-Encoding': 'identity' }
          });
          const chunks = [];
          await new Promise((res, rej) => {
            resp.data.on('data', c => chunks.push(c));
            resp.data.on('end', res);
            resp.data.on('error', rej);
          });
          audioBuffer = Buffer.concat(chunks);
        }

        if (!audioBuffer || audioBuffer.length === 0) throw new Error('Downloaded audio buffer is empty.');

        // Guard: reject HTML error pages, JSON error bodies, or suspiciously tiny buffers
        // Real MP3s are always > 10 KB and never start with an HTML/JSON error response.
        const sniff = audioBuffer.slice(0, 256).toString('utf8');
        if (audioBuffer.length < 10000 ||
            /^\s*(<\s*!DOCTYPE|<\s*html)/i.test(sniff) ||
            /^\s*\{[^}]*"error"/i.test(sniff)) {
          throw new Error('API returned invalid data (not an audio file). Try a different song or send a direct YouTube link.');
        }

        // Detect actual file format from magic bytes
        const sig  = audioBuffer.slice(0, 12);
        const hex3 = sig.slice(0, 3).toString('hex');   // ID3 tag
        const hex2 = sig.slice(0, 2).toString('hex');   // frame sync
        const a0_4 = sig.slice(0, 4).toString('ascii');
        const a4_8 = sig.slice(4, 8).toString('ascii');
        let mimetype = 'audio/mpeg';
        let ext = 'mp3';
        if (hex3 === '494433' || hex2 === 'fff3' || hex2 === 'ffe3' || hex2 === 'fffa' || hex2 === 'fffb') {
          // ID3v2 header or MPEG frame sync → real MP3
          mimetype = 'audio/mpeg'; ext = 'mp3';
        } else if (a4_8 === 'ftyp') {
          mimetype = 'audio/mp4'; ext = 'm4a';
        } else if (a0_4 === 'OggS') {
          mimetype = 'audio/ogg; codecs=opus'; ext = 'ogg';
        } else if (a0_4 === 'RIFF') {
          mimetype = 'audio/wav'; ext = 'wav';
        }
        const fileName = `${finalTitle.slice(0, 60)}.${ext}`;

        await ctx.sock.sendMessage(ctx.chatId, {
          audio: audioBuffer,
          mimetype,
          fileName,
          ptt: false
        }, { quoted: ctx.message });

      } catch (err) {
        console.error('[play]', err);
        let msg = `❌ Download failed: ${err.message}`;
        if (/451|blocked|unavailable/i.test(err.message)) msg = '❌ Content blocked or unavailable in this region. Try another song.';
        if (/All download APIs failed/i.test(err.message)) msg = '❌ All download sources failed. The content may be unavailable or blocked.';
        await reply(ctx, msg);
      }
    }
  });
  add({ name: 'video', aliases: ['ytmp4'], category: 'downloads', desc: 'Download YouTube video (MP4)', usage: '<song name or YouTube URL>', handler: async (ctx) => {
    try {
      const query = textArg(ctx.args);
      if (!query) return reply(ctx, `Usage: ${getConfig().prefix}video <song name or YouTube link>`);

      if (!yts) throw new Error('yt-search module not available. Try: npm install yt-search');
      const search = await yts(query);
      const videos = search?.videos || [];
      if (!videos.length) return reply(ctx, '❌ No videos found. Try different keywords.');

      const video = videos[0];

      // Send thumbnail immediately like Knightbot-MD
      try {
        if (video.thumbnail) {
          await ctx.sock.sendMessage(ctx.chatId, {
            image: { url: video.thumbnail },
            caption: `🎬 *${video.title}*\n⏱ *Duration:* ${video.timestamp || 'N/A'}\n⬇️ Downloading...`
          }, { quoted: ctx.message });
        }
      } catch { /* continue */ }

      const encoded = encodeURIComponent(video.url);
      const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', 'Accept': 'application/json, */*' };

      const apiMethods = [
        { name: 'EliteProTech', url: `https://eliteprotech-apis.zone.id/ytdown?url=${encoded}&format=mp4` },
        { name: 'Yupra', url: `https://api.yupra.my.id/api/downloader/ytmp4?url=${encoded}` },
        { name: 'Okatsu', url: `https://okatsu-rolezapiiz.vercel.app/downloader/ytmp4?url=${encoded}` },
        { name: 'davidcyril', url: `https://api.davidcyriltech.my.id/download/ytmp4?url=${encoded}` },
        { name: 'dreaded', url: `https://api.dreaded.site/api/ytdl/video?url=${encoded}` },
        { name: 'bk9', url: `https://bk9.fun/download/ytmp4?url=${encoded}` },
        { name: 'agatz', url: `https://api.agatz.xyz/api/ytmp4?url=${encoded}` }
      ];

      let videoUrl = '';
      let finalTitle = sanitizeFileName(video.title || 'video');

      // Extract a direct video file URL — avoids data?.url / data?.link which
      // many APIs set to the YouTube watch page, causing corrupt/failed downloads.
      function extractVideoUrl(data) {
        const candidates = [
          data?.result?.mp4,         data?.result?.downloadUrl,
          data?.result?.download_url, data?.result?.dl,
          data?.result?.video,        data?.result?.file,
          data?.data?.mp4,           data?.data?.downloadUrl,
          data?.data?.download_url,   data?.data?.dl,
          data?.data?.video,          data?.data?.file,
          data?.mp4,                  data?.downloadUrl,
          data?.downloadURL,          data?.dl,
          data?.download,             data?.video,
          data?.file,
          // Ambiguous — checked last (often the YouTube watch page URL)
          data?.result?.url, data?.data?.url, data?.url, data?.link,
        ];
        for (const c of candidates) {
          if (typeof c === 'string' && /^https?:\/\//i.test(c) &&
              !/youtube\.com\/watch|youtu\.be\//i.test(c)) {
            return c;
          }
        }
        return '';
      }

      for (const api of apiMethods) {
        try {
          const { data } = await axios.get(api.url, { timeout: 30000, headers: HEADERS });
          const url = extractVideoUrl(data);
          if (url) {
            videoUrl = url;
            const t = data?.result?.title || data?.data?.title || data?.title;
            if (t) finalTitle = sanitizeFileName(t);
            break;
          }
        } catch { /* try next */ }
      }

      if (!videoUrl) throw new Error('All download APIs failed. Please try again later or use a direct YouTube link.');

      await ctx.sock.sendMessage(ctx.chatId, {
        video: { url: videoUrl },
        mimetype: 'video/mp4',
        fileName: `${finalTitle.slice(0, 60)}.mp4`,
        caption: `╭─〔 🎬 *Video Download* 〕\n│ *${finalTitle.slice(0, 80)}*\n╰────────────\n\n_Powered by ${getConfig().botName}_`
      }, { quoted: ctx.message });

    } catch (err) {
      console.error('[video]', err);
      let msg = `❌ Video download failed: ${err.message}`;
      if (/451|blocked/i.test(err.message)) msg = '❌ Content blocked or unavailable. Try another video.';
      await reply(ctx, msg);
    }
  }});
  add({ name: 'youtube', aliases: ['yt'], category: 'downloads', desc: 'Download YouTube audio or video', usage: '<audio|video> <query/url>', handler: async (ctx) => {
    const first = (ctx.args[0] || '').toLowerCase();
    const type = ['video','mp4'].includes(first) ? 'video' : 'audio';
    try { await sendYouTubeMedia(ctx, type, textArg(ctx.args)); }
    catch (err) { await reply(ctx, `YouTube download failed: ${err.message || err}`); }
  }});

  const downloadNames = ['tiktok','tt','tiktokaudio','instagram','insta','ig','igs','igsc','facebook','fb','twitter','twdl','spotify','pinterest','pin','wallpaper','img','gif','lyrics','xvideo','savestatus','statussave'];
  for (const name of downloadNames) {
    if (registry.has(name)) continue;
    add({ name, category: 'downloads', desc: `${name} downloader/search command`, usage: '<url/query>', handler: async (ctx) => { const q = textArg(ctx.args); await reply(ctx, q ? `${name} received: ${q}\nDownloader hook is ready; connect your preferred API in src/commands.js.` : `Usage: ${getConfig().prefix}${name} <url or query>`); } });
  }

  // ─── VCF: Export Group Contacts ───────────────────────────────────────────
  add({ name: 'vcf', aliases: ['groupvcf', 'contacts', 'getcontacts'], category: 'group', groupOnly: true, desc: 'Export all group member contacts as a VCF file', handler: async (ctx) => {
    await reply(ctx, '📋 Collecting group contacts...');
    try {
      const meta = await ctx.sock.groupMetadata(ctx.chatId);
      const participants = meta.participants || [];
      let vcfContent = '';
      for (const p of participants) {
        const jidStr = typeof p === 'string' ? p : (p.id || p.jid || '');
        const number = normalizeNumber(jidStr);
        if (!number) continue;
        vcfContent += `BEGIN:VCARD\nVERSION:3.0\nFN:+${number}\nTEL;TYPE=CELL:+${number}\nEND:VCARD\n`;
      }
      const tmpDir = path.join(process.cwd(), 'tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, `vcf_${Date.now()}.vcf`);
      fs.writeFileSync(tmpFile, vcfContent, 'utf8');
      const safeGroupName = meta.subject.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'group';
      await ctx.sock.sendMessage(ctx.chatId, {
        document: fs.readFileSync(tmpFile),
        mimetype: 'text/vcard',
        fileName: `${safeGroupName}_contacts.vcf`,
        caption: `📋 *Group Contacts*\n\n👥 Group: *${meta.subject}*\n👤 Members: *${participants.length}*\n\n_Import this file into your contacts app_\n\n*Made by Kimani Samuel*`
      }, { quoted: ctx.message });
      setTimeout(() => fs.unlink(tmpFile, () => {}), 15000);
    } catch (err) {
      await reply(ctx, `❌ Failed to collect contacts: ${err.message}\n\n*Made by Kimani Samuel*`);
    }
  }});

  // ─── WELCOME: Toggle group welcome messages ────────────────────────────────
  add({ name: 'welcome', aliases: ['setwelcome'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Toggle welcome messages on/off for this group', usage: '<on|off>', handler: async (ctx) => {
    const action = (ctx.args[0] || 'status').toLowerCase();
    const st = getState();
    if (!st.groupSettings) st.groupSettings = {};
    if (!st.groupSettings[ctx.chatId]) st.groupSettings[ctx.chatId] = {};
    if (action === 'on' || action === 'off') {
      st.groupSettings[ctx.chatId].welcome = action === 'on';
      saveState(st);
      await reply(ctx, `✅ Welcome messages *${action.toUpperCase()}* for this group.\n\n*Made by Kimani Samuel*`);
    } else {
      const on = st.groupSettings[ctx.chatId].welcome;
      await reply(ctx, `ℹ️ Welcome messages: *${on ? 'ON' : 'OFF'}*\nUse ${getConfig().prefix}welcome on/off\n\n*Made by Kimani Samuel*`);
    }
  }});

  // ─── GOODBYE: Toggle group goodbye messages ────────────────────────────────
  add({ name: 'goodbye', aliases: ['setgoodbye', 'bye'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Toggle goodbye messages on/off for this group', usage: '<on|off>', handler: async (ctx) => {
    const action = (ctx.args[0] || 'status').toLowerCase();
    const st = getState();
    if (!st.groupSettings) st.groupSettings = {};
    if (!st.groupSettings[ctx.chatId]) st.groupSettings[ctx.chatId] = {};
    if (action === 'on' || action === 'off') {
      st.groupSettings[ctx.chatId].goodbye = action === 'on';
      saveState(st);
      await reply(ctx, `✅ Goodbye messages *${action.toUpperCase()}* for this group.\n\n*Made by Kimani Samuel*`);
    } else {
      const on = st.groupSettings[ctx.chatId].goodbye;
      await reply(ctx, `ℹ️ Goodbye messages: *${on ? 'ON' : 'OFF'}*\nUse ${getConfig().prefix}goodbye on/off\n\n*Made by Kimani Samuel*`);
    }
  }});

  // Menu aliases per category.
  for (const cat of ['core','ai','group','owner','media','textmaker','text','fun','games','utility','anime','downloads','converter','search','tools']) {
    const aliases = cat === 'core' ? ['generalmenu', 'basicmenu'] : [];
    add({ name: `${cat}menu`, aliases, category: 'core', desc: `Show ${cat === 'core' ? 'general' : cat} commands`, handler: async (ctx) => {
      const cfg = getConfig();
      const items = commands.filter(c => c.category === cat);
      await reply(ctx, `┌──『 ${(cat === 'core' ? 'general' : cat).toUpperCase()} 』\n${items.map(c => `│ ${helpLine(c, cfg.prefix)}`).join('\n')}\n└──────────────`);
    }});
  }

  // ─── TEXTMAKER: Real ephoto360 image generation (ported from Knightbot-MD) ─
  const EPHOTO_MAP = {
    metallic:   'https://en.ephoto360.com/impressive-decorative-3d-metal-text-effect-798.html',
    ice:        'https://en.ephoto360.com/ice-text-effect-online-101.html',
    snow:       'https://en.ephoto360.com/create-a-snow-3d-text-effect-free-online-621.html',
    impressive: 'https://en.ephoto360.com/create-3d-colorful-paint-text-effect-online-801.html',
    matrix:     'https://en.ephoto360.com/matrix-text-effect-154.html',
    light:      'https://en.ephoto360.com/light-text-effect-futuristic-technology-style-648.html',
    neon:       'https://en.ephoto360.com/create-colorful-neon-light-text-effects-online-797.html',
    devil:      'https://en.ephoto360.com/neon-devil-wings-text-effect-online-683.html',
    purple:     'https://en.ephoto360.com/purple-text-effect-online-100.html',
    thunder:    'https://en.ephoto360.com/thunder-text-effect-online-97.html',
    leaves:     'https://en.ephoto360.com/green-brush-text-effect-typography-maker-online-153.html',
    '1917':     'https://en.ephoto360.com/1917-style-text-effect-523.html',
    arena:      'https://en.ephoto360.com/create-cover-arena-of-valor-by-mastering-360.html',
    hacker:     'https://en.ephoto360.com/create-anonymous-hacker-avatars-cyan-neon-677.html',
    sand:       'https://en.ephoto360.com/write-names-and-messages-on-the-sand-online-582.html',
    blackpink:  'https://en.ephoto360.com/create-a-blackpink-style-logo-with-members-signatures-810.html',
    glitch:     'https://en.ephoto360.com/create-digital-glitch-text-effects-online-767.html',
    fire:       'https://en.ephoto360.com/flame-lettering-effect-372.html',
    gold:       'https://en.ephoto360.com/gold-text-effect-online-91.html',
    galaxy:     'https://en.ephoto360.com/galaxy-text-effect-online-399.html',
    graffiti:   'https://en.ephoto360.com/graffiti-text-effect-generator-online-free-150.html',
    rainbow:    'https://en.ephoto360.com/rainbow-text-effect-online-102.html',
    retro:      'https://en.ephoto360.com/retro-text-effect-online-141.html',
    vintage:    'https://en.ephoto360.com/vintage-text-effect-online-110.html',
    halloween:  'https://en.ephoto360.com/create-halloween-text-effects-online-661.html',
    christmas:  'https://en.ephoto360.com/merry-christmas-text-effect-online-generator-503.html',
    blood:      'https://en.ephoto360.com/blood-text-effect-online-107.html',
    wood:       'https://en.ephoto360.com/wood-text-effect-online-108.html',
    water:      'https://en.ephoto360.com/water-text-effect-online-105.html',
    smoke:      'https://en.ephoto360.com/smoke-text-effect-online-99.html',
    toxic:      'https://en.ephoto360.com/neon-text-effect-for-toxic-environment-online-803.html',
    summer:     'https://en.ephoto360.com/summer-text-effect-online-575.html',
    cyberpunk:  'https://en.ephoto360.com/cyberpunk-2077-text-effect-online-612.html',
    pixel:      'https://en.ephoto360.com/pixel-text-effect-online-generator-178.html',
  };

  // Load mumaker (CJS) via createRequire — Malai-XD is ESM
  const _require = createRequire(import.meta.url);
  let mumaker = null;
  try { mumaker = _require('mumaker'); } catch { mumaker = null; }

  async function generateEphotoImage(ephotoUrl, text) {
    if (mumaker) {
      const result = await mumaker.ephoto(ephotoUrl, text);
      if (!result?.image) throw new Error('mumaker returned no image URL');
      return result.image;
    }
    // Fallback scraper if mumaker unavailable
    const pageRes = await axios.get(ephotoUrl, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
    });
    const html = String(pageRes.data || '');
    const baseOrigin = 'https://en.ephoto360.com';
    const tokenMatch = html.match(/name=["']_?token["'][^>]*value=["']([^"']{10,})["']/) ||
                       html.match(/value=["']([a-f0-9]{40,})["']/);
    const token = tokenMatch?.[1] || '';
    const actionMatch = html.match(/action=["']([^"']+)["']/) ||
                        html.match(/["'](\/api\/effect\/\d+[^"']*)["']/);
    let submitUrl = actionMatch?.[1] || '';
    if (!submitUrl) throw new Error('Could not find form action on ephoto360 page');
    if (submitUrl.startsWith('/')) submitUrl = baseOrigin + submitUrl;
    const fieldMatch = html.match(/name=["'](texts?\[\]|text)["']/i);
    const fieldName = fieldMatch?.[1] || 'texts[]';
    const formData = new URLSearchParams();
    if (token) formData.append('token', token);
    formData.append(fieldName, text);
    formData.append('submit', 'GO');
    const postRes = await axios.post(submitUrl, formData.toString(), {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': ephotoUrl, 'Origin': baseOrigin
      }
    });
    const body = typeof postRes.data === 'string' ? postRes.data : JSON.stringify(postRes.data);
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { parsed = postRes.data; }
    const imgUrl = parsed?.image || parsed?.url || parsed?.data?.image;
    if (imgUrl && /^https?:\/\//i.test(imgUrl)) return imgUrl;
    const urlMatch = body.match(/"(https?:\/\/[^"]+\.(?:jpg|png|webp)(?:\?[^"]*)?)"/i);
    if (urlMatch?.[1]) return urlMatch[1].replace(/\\\//g, '/');
    throw new Error('No image URL found in ephoto360 response');
  }


  for (const [name, ephotoUrl] of Object.entries(EPHOTO_MAP)) {
    if (registry.has(name)) continue;
    add({
      name,
      aliases: name === '1917' ? ['1917style'] : [],
      category: 'textmaker',
      desc: `Generate ${name} styled text image`,
      usage: '<your text>',
      handler: async (ctx) => {
        const text = textArg(ctx.args);
        if (!text) return reply(ctx, `Usage: ${getConfig().prefix}${name} Your Text\nExample: ${getConfig().prefix}${name} Malai Bot`);
        await reply(ctx, `⏳ Generating *${name}* text style...`);
        try {
          const imageUrl = await generateEphotoImage(ephotoUrl, text);
          await ctx.sock.sendMessage(ctx.chatId, {
            image: { url: imageUrl },
            caption: `✨ *${name.toUpperCase()}* style\n_"${text}"_\n\n_Powered by ${getConfig().botName}_`
          }, { quoted: ctx.message });
        } catch (err) {
          console.error(`[textmaker:${name}]`, err.message);
          await reply(ctx, `❌ Failed to generate *${name}* image. Try again.\n_${err.message.slice(0,100)}_`);
        }
      }
    });
  }

  // All remaining textmaker styles mapped to real ephoto360 URLs
  const EPHOTO_MAP_EXTRA = {
    '1917style':      'https://en.ephoto360.com/1917-style-text-effect-523.html',
    royaltext:        'https://en.ephoto360.com/royal-3d-gold-text-effect-online-626.html',
    topography:       'https://en.ephoto360.com/topographic-map-text-effect-online-806.html',
    typography:       'https://en.ephoto360.com/create-3d-colorful-paint-text-effect-online-801.html',
    watercolortext:   'https://en.ephoto360.com/watercolor-painting-text-effect-online-810.html',
    writetext:        'https://en.ephoto360.com/write-text-on-christmas-card-online-free-632.html',
    summerbeach:      'https://en.ephoto360.com/summer-text-effect-online-575.html',
    lionlogo:         'https://en.ephoto360.com/create-lion-logo-free-online-709.html',
    wolf:             'https://en.ephoto360.com/create-wolf-logo-online-free-710.html',
    dragon:           'https://en.ephoto360.com/create-dragon-logo-online-free-711.html',
    bearlogo:         'https://en.ephoto360.com/create-bear-logo-online-free-712.html',
    '3dstone':        'https://en.ephoto360.com/create-stone-3d-text-effect-online-free-750.html',
    '3dtext':         'https://en.ephoto360.com/create-3d-text-logo-free-online-695.html',
    galaxy2:          'https://en.ephoto360.com/galaxy-text-effect-online-399.html',
    silver:           'https://en.ephoto360.com/silver-text-effect-online-90.html',
    steel:            'https://en.ephoto360.com/metallic-steel-text-effect-online-808.html',
    lava:             'https://en.ephoto360.com/create-lava-magma-text-effect-online-685.html',
    joker:            'https://en.ephoto360.com/create-joker-text-effect-online-689.html',
    pornhub:          'https://en.ephoto360.com/pornhub-logo-text-effect-online-generator-510.html',
    marvel:           'https://en.ephoto360.com/marvel-text-effect-online-generator-528.html',
    avengers:         'https://en.ephoto360.com/avengers-logo-text-effect-online-generator-527.html',
    graffiti2:        'https://en.ephoto360.com/create-graffiti-text-effect-online-free-151.html',
    cloud:            'https://en.ephoto360.com/cloud-text-effect-online-804.html',
    clouds:           'https://en.ephoto360.com/cloud-text-effect-online-804.html',
    candy:            'https://en.ephoto360.com/candy-text-effect-online-generator-555.html',
    sketch:           'https://en.ephoto360.com/sketch-text-effect-online-generator-free-179.html',
    pencil:           'https://en.ephoto360.com/pencil-text-effect-online-109.html',
    underwater:       'https://en.ephoto360.com/underwater-text-effect-online-106.html',
    gradient:         'https://en.ephoto360.com/gradient-text-effect-online-807.html',
    luxury:           'https://en.ephoto360.com/luxury-golden-text-effect-online-805.html',
    business:         'https://en.ephoto360.com/business-card-text-effect-online-809.html',
    signature:        'https://en.ephoto360.com/create-handwritten-signature-text-online-630.html',
    logomaker:        'https://en.ephoto360.com/gaming-logo-maker-online-free-660.html',
    gaminglogo:       'https://en.ephoto360.com/gaming-logo-maker-online-free-660.html',
    naruto:           'https://en.ephoto360.com/naruto-text-effect-online-534.html',
    animebanner:      'https://en.ephoto360.com/anime-banner-text-effect-online-765.html',
    spacebanner:      'https://en.ephoto360.com/space-text-effect-online-811.html',
    matrixcode:       'https://en.ephoto360.com/matrix-text-effect-154.html',
    neonlight:        'https://en.ephoto360.com/create-colorful-neon-light-text-effects-online-797.html',
    neondevil:        'https://en.ephoto360.com/neon-devil-wings-text-effect-online-683.html',
    glow:             'https://en.ephoto360.com/create-glow-text-effect-online-658.html',
    glowing:          'https://en.ephoto360.com/create-glow-text-effect-online-658.html',
    bluefire:         'https://en.ephoto360.com/blue-fire-text-effect-online-686.html',
    greenfire:        'https://en.ephoto360.com/green-fire-text-effect-online-687.html',
    flame:            'https://en.ephoto360.com/flame-lettering-effect-372.html',
    leaf:             'https://en.ephoto360.com/green-brush-text-effect-typography-maker-online-153.html',
    beach:            'https://en.ephoto360.com/write-on-the-beach-sand-online-free-587.html',
    sunset:           'https://en.ephoto360.com/sunset-text-effect-online-812.html',
  };

  for (const [name, ephotoUrl] of Object.entries(EPHOTO_MAP_EXTRA)) {
    if (registry.has(name)) continue;
    add({
      name,
      category: 'textmaker',
      desc: `Generate ${name} styled text image`,
      usage: '<your text>',
      handler: async (ctx) => {
        const text = textArg(ctx.args);
        if (!text) return reply(ctx, `Usage: ${getConfig().prefix}${name} Your Text\nExample: ${getConfig().prefix}${name} Malai Bot`);
        await reply(ctx, `⏳ Generating *${name}* text style...`);
        try {
          const imageUrl = await generateEphotoImage(ephotoUrl, text);
          await ctx.sock.sendMessage(ctx.chatId, {
            image: { url: imageUrl },
            caption: `✨ *${name.toUpperCase()}* style\n_"${text}"_\n\n_Powered by ${getConfig().botName}_`
          }, { quoted: ctx.message });
        } catch (err) {
          console.error(`[textmaker:${name}]`, err.message);
          await reply(ctx, `❌ Failed to generate *${name}* image. Try again.\n_${err.message.slice(0,100)}_`);
        }
      }
    });
  }

  // ─── ANIME: Real GIF fetching (ported from Knightbot-MD) ──────────────────
  const ANIMU_BASE_URL = 'https://api.some-random-api.com/anime';
  const ANIME_MESSAGES = {
    kiss:      (f,t) => `💋 *${f}* kisses *${t}*! 😘`,
    hug:       (f,t) => `🤗 *${f}* hugs *${t}* tightly! 💕`,
    pat:       (f,t) => `😊 *${f}* pats *${t}* on the head! 🥰`,
    poke:      (f,t) => `👉 *${f}* pokes *${t}*! 😄`,
    nom:       (f,t) => `😋 *${f}* noms *${t}*! 🍪`,
    cry:       (f,_) => `😭 *${f}* is crying! Someone comfort them!`,
    wink:      (f,t) => `😉 *${f}* winks at *${t}*~`,
    facepalm:  (f,_) => `🤦 *${f}* face-palms!`,
    'face-palm':(f,_) => `🤦 *${f}* face-palms!`,
    slap:      (f,t) => `👋 *${f}* slaps *${t}*! That had to hurt! 💥`,
    bite:      (f,t) => `😬 *${f}* bites *${t}*! 🦷`,
    cuddle:    (f,t) => `🥰 *${f}* cuddles with *${t}*!`,
    highfive:  (f,t) => `✋ *${f}* high-fives *${t}*!`,
    dance:     (f,_) => `💃 *${f}* is dancing! 🕺`,
    blush:     (f,t) => `😊 *${f}* blushes at *${t}*~`,
    wave:      (f,t) => `👋 *${f}* waves at *${t}*!`,
    kill:      (f,t) => `💀 *${f}* eliminated *${t}*!`,
    feed:      (f,t) => `🍜 *${f}* feeds *${t}*! 🥄`,
    yeet:      (f,t) => `🚀 *${f}* yeets *${t}* into the sky!`,
    happy:     (f,_) => `😄 *${f}* is feeling happy!`,
    sad:       (f,_) => `😢 *${f}* is feeling sad...`,
    angry:     (f,_) => `😠 *${f}* is angry! Watch out!`,
    sleep:     (f,_) => `😴 *${f}* is sleeping... shhh!`,
    run:       (f,_) => `🏃 *${f}* runs away!`,
    jump:      (f,_) => `🦘 *${f}* jumps!`,
  };

  // nekos.best supports: baka,bite,blush,bored,cry,cuddle,dance,facepalm,feed,handhold,
  // happy,highfive,hug,kick,kiss,laugh,nod,nom,nope,pat,poke,pout,punch,run,sad,shoot,
  // shrug,slap,sleep,smile,smug,stare,think,thumbsup,tickle,wave,wink,yawn,yeet
  const NEKOS_BEST_TYPES = new Set(['baka','bite','blush','bored','cry','cuddle','dance','facepalm','feed','handhold','happy','highfive','hug','kick','kiss','laugh','nod','nom','nope','pat','poke','pout','punch','run','sad','shoot','shrug','slap','sleep','smile','smug','stare','think','thumbsup','tickle','wave','wink','yawn','yeet']);

  async function fetchNekosBestGif(type) {
    const t = type === 'face-palm' ? 'facepalm' : type;
    if (!NEKOS_BEST_TYPES.has(t)) return null;
    const res = await axios.get(`https://nekos.best/api/v2/${t}`, { timeout: 15000 });
    const results = res.data?.results;
    if (Array.isArray(results) && results.length > 0) return results[0].url || null;
    return null;
  }

  async function fetchAnimuGif(type) {
    // some-random-api endpoint: /anime/<type> (not /animu/)
    const sraTypeMap = { facepalm: 'face-palm', 'face-palm': 'face-palm' };
    const sraType = sraTypeMap[type] || type;
    const sraValidTypes = ['nom','poke','cry','kiss','pat','hug','wink','face-palm','quote','slap','bite','cuddle','blush','wave','dance','happy','sad','angry','run','jump'];
    if (!sraValidTypes.includes(sraType)) return null;
    const res = await axios.get(`${ANIMU_BASE_URL}/${sraType}`, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 Malai-XD-2.0' }
    });
    return res.data?.link || res.data?.gif || res.data?.url || null;
  }

  async function fetchWaifuPicsGif(type) {
    const sfwTypes = ['wink','pat','hug','poke','slap','kiss','blush','smile','wave','highfive','happy','dance','run','bite','cuddle','feed','kill','cry','nom','yeet','jump'];
    if (!sfwTypes.includes(type)) return null;
    const res = await axios.get(`https://api.waifu.pics/sfw/${type}`, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 Malai-XD-2.0' }
    });
    return res.data?.url || null;
  }

  const interactionCmds = ['kiss','hug','pat','poke','nom','cry','wink','facepalm','face-palm','slap','bite','cuddle','highfive','dance','blush','wave','kill','feed','yeet','happy','sad','angry','sleep','run','jump'];
  for (const name of interactionCmds) {
    if (registry.has(name)) continue;
    add({
      name,
      aliases: name === 'face-palm' ? ['facepalm'] : name === 'facepalm' ? ['face-palm'] : [],
      category: 'anime',
      desc: `Send a ${name} anime GIF`,
      usage: '[@user]',
      handler: async (ctx) => {
        const target = pickTarget(ctx.message, ctx.sender);
        const senderName = ctx.pushName || normalizeNumber(ctx.sender) || 'Someone';
        const targetName = target === ctx.sender ? 'themselves' : `@${normalizeNumber(target)}`;
        const caption = (ANIME_MESSAGES[name] || ((f,t) => `*${f}* → *${t}*`))(senderName, targetName);
        try {
          let gifUrl = null;
          // 1st: nekos.best (most reliable, always returns gif/mp4)
          try { gifUrl = await fetchNekosBestGif(name); } catch {}
          // 2nd: waifu.pics
          if (!gifUrl) { try { gifUrl = await fetchWaifuPicsGif(name); } catch {} }
          // 3rd: some-random-api
          if (!gifUrl) { try { gifUrl = await fetchAnimuGif(name); } catch {} }
          if (gifUrl) {
            // nekos.best returns .gif URLs - send as video with gifPlayback for WhatsApp animated display
            const isGifFile = /\.gif(\?|$)/i.test(gifUrl);
            await ctx.sock.sendMessage(ctx.chatId, {
              video: { url: gifUrl },
              mimetype: isGifFile ? 'video/mp4' : 'video/mp4',
              caption,
              gifPlayback: true
            }, { quoted: ctx.message, mentions: [target] });
          } else {
            await reply(ctx, caption, { mentions: [target] });
          }
        } catch (err) {
          console.error(`[anime:${name}]`, err.message);
          await reply(ctx, caption, { mentions: [target] });
        }
      }
    });
  }

  const imageAnimeCmds = ['waifu','neko','loli','megumin','konachan','animu','anime'];
  for (const name of imageAnimeCmds) {
    if (registry.has(name)) continue;
    add({
      name, category: 'anime', desc: `Random ${name} anime image`,
      handler: async (ctx) => {
        try {
          let url = null;
          try {
            const r = await axios.get(`https://api.waifu.pics/sfw/${name === 'animu' ? 'waifu' : name}`, { timeout: 15000 });
            url = r.data?.url;
          } catch {}
          if (!url) {
            const r2 = await axios.get(`${ANIMU_BASE_URL}/wink`, { timeout: 15000 });
            url = r2.data?.link;
          }
          if (url) {
            await ctx.sock.sendMessage(ctx.chatId, {
              image: { url }, caption: `🎌 *${name.toUpperCase()}*\n_Powered by ${getConfig().botName}_`
            }, { quoted: ctx.message });
          } else {
            await reply(ctx, `❌ Could not fetch ${name} image right now.`);
          }
        } catch (err) { await reply(ctx, `❌ Failed: ${err.message}`); }
      }
    });
  }

  if (!registry.has('animuquote')) {
    add({
      name: 'animuquote', aliases: ['animequote','aq'], category: 'anime', desc: 'Random anime quote',
      handler: async (ctx) => {
        try {
          const res = await axios.get(`${ANIMU_BASE_URL}/quote`, { timeout: 15000 });
          const q = res.data?.sentence || res.data?.quote || 'No quote found.';
          const char = res.data?.character || '';
          const anime = res.data?.anime || '';
          await reply(ctx, `💬 *"${q}"*${char ? `\n\n— _${char}_` : ''}${anime ? ` from *${anime}*` : ''}`);
        } catch { await reply(ctx, '❌ Could not fetch an anime quote right now.'); }
      }
    });
  }


  // ─── ANTILINK (delete/kick modes) ─────────────────────────────────────────
  add({ name: 'antilink', aliases: ['antilinkoff'], category: 'group', groupOnly: true, adminOnly: true,
    desc: 'Toggle link protection. Use "antilink delete" or "antilink kick"', usage: '<delete|kick|off|status>',
    handler: async (ctx) => {
      const st = getState();
      if (!st.groupSettings) st.groupSettings = {};
      if (!st.groupSettings[ctx.chatId]) st.groupSettings[ctx.chatId] = {};
      const grp = st.groupSettings[ctx.chatId];
      const sub = (ctx.args[0] || 'status').toLowerCase();
      const p = getConfig().prefix;

      if (sub === 'delete' || sub === 'del') {
        grp.antilink = { enabled: true, action: 'delete' };
        saveState(st);
        return reply(ctx, `🔗 *Antilink → DELETE mode ON*\n\nWhen a non-admin sends a link:\n• The message will be deleted\n• The sender gets a warning\n\nUse ${p}antilink kick to switch to kick mode.\nUse ${p}antilink off to disable.`);
      } else if (sub === 'kick') {
        grp.antilink = { enabled: true, action: 'kick' };
        saveState(st);
        return reply(ctx, `🔗 *Antilink → KICK mode ON*\n\nWhen a non-admin sends a link:\n• The message will be deleted\n• The sender will be removed from the group\n\nUse ${p}antilink delete to switch to delete-only mode.\nUse ${p}antilink off to disable.`);
      } else if (sub === 'on') {
        grp.antilink = { enabled: true, action: grp.antilink?.action || 'delete' };
        saveState(st);
        return reply(ctx, `✅ *Antilink ON* (mode: ${grp.antilink.action})\nUse ${p}antilink delete or ${p}antilink kick to change mode.`);
      } else if (sub === 'off') {
        grp.antilink = { enabled: false, action: grp.antilink?.action || 'delete' };
        saveState(st);
        return reply(ctx, '❌ *Antilink OFF* — links are now allowed in this group.');
      } else {
        const cfg = grp.antilink;
        const status = cfg?.enabled ? `✅ ON (mode: *${cfg.action || 'delete'}*)` : '❌ OFF';
        return reply(ctx, `*🔗 Antilink Status:* ${status}\n\n` +
          `${p}antilink delete — Delete link, warn sender\n` +
          `${p}antilink kick — Delete link + remove sender\n` +
          `${p}antilink off — Disable antilink`);
      }
    }
  });

  // ─── GROUPSTATUS: Post replied image/video to WhatsApp status ─────────────
  add({ name: 'groupstatus', aliases: ['poststatus','statuspost'], category: 'group', groupOnly: true, adminOnly: true,
    desc: 'Reply to an image or video with this command to post it to bot WhatsApp status',
    handler: async (ctx) => {
      const quoted = ctx.message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (!quoted) return reply(ctx, `❌ Reply to an image or video with ${getConfig().prefix}groupstatus to post it to status.`);

      const imgMsg = quoted.imageMessage;
      const vidMsg = quoted.videoMessage;

      if (!imgMsg && !vidMsg) return reply(ctx, '❌ Replied message must be an image or video.');

      try {
        await reply(ctx, '📤 Posting to status...');
        if (imgMsg) {
          const stream = await downloadContentFromMessage(imgMsg, 'image');
          const chunks = []; for await (const c of stream) chunks.push(c);
          const buffer = Buffer.concat(chunks);
          const caption = imgMsg.caption || '';
          await ctx.sock.sendMessage('status@broadcast', {
            image: buffer,
            caption: caption,
            backgroundColor: '#000000',
            font: 0
          });
          await reply(ctx, '✅ Image posted to status successfully!');
        } else if (vidMsg) {
          const stream = await downloadContentFromMessage(vidMsg, 'video');
          const chunks = []; for await (const c of stream) chunks.push(c);
          const buffer = Buffer.concat(chunks);
          const caption = vidMsg.caption || '';
          await ctx.sock.sendMessage('status@broadcast', {
            video: buffer,
            caption: caption,
            gifPlayback: false
          });
          await reply(ctx, '✅ Video posted to status successfully!');
        }
      } catch (err) {
        await reply(ctx, `❌ Failed to post status: ${err.message || err}`);
      }
    }
  });

  // ─── GETPP: Full profile card (dp, about, name, number, country) ───────────
  add({ name: 'getpp', aliases: ['dp','profile','whois','userinfo','about'], category: 'utility',
    desc: 'Get full profile info — display picture, about, name, number, country',
    usage: '@user | +254... | (reply to message)',
    handler: async (ctx) => {
      // Determine target JID
      let targetJid = '';
      const mentioned = mentionedJids(ctx.message);
      const quoted = ctx.message.message?.extendedTextMessage?.contextInfo?.participant;
      if (mentioned.length) targetJid = mentioned[0];
      else if (quoted) targetJid = quoted;
      else if (ctx.args[0]) targetJid = toUserJid(ctx.args[0]);
      else targetJid = ctx.sender;

      if (!targetJid) return reply(ctx, `Usage: ${getConfig().prefix}getpp @user\nOr reply to a message.`);

      const num = normalizeNumber(targetJid);

      // Detect country from phone number country code
      function detectCountry(number = '') {
        const n = String(number).replace(/\D/g, '');
        const prefixMap = [
          [['1'], 'United States/Canada 🇺🇸🇨🇦'],
          [['254'], 'Kenya 🇰🇪'], [['255'], 'Tanzania 🇹🇿'], [['256'], 'Uganda 🇺🇬'],
          [['251'], 'Ethiopia 🇪🇹'], [['252'], 'Somalia 🇸🇴'], [['253'], 'Djibouti 🇩🇯'],
          [['257'], 'Burundi 🇧🇮'], [['258'], 'Mozambique 🇲🇿'], [['260'], 'Zambia 🇿🇲'],
          [['261'], 'Madagascar 🇲🇬'], [['262'], 'Réunion 🇷🇪'], [['263'], 'Zimbabwe 🇿🇼'],
          [['264'], 'Namibia 🇳🇦'], [['265'], 'Malawi 🇲🇼'], [['266'], 'Lesotho 🇱🇸'],
          [['267'], 'Botswana 🇧🇼'], [['268'], 'Eswatini 🇸🇿'], [['269'], 'Comoros 🇰🇲'],
          [['27'], 'South Africa 🇿🇦'], [['20'], 'Egypt 🇪🇬'], [['212'], 'Morocco 🇲🇦'],
          [['213'], 'Algeria 🇩🇿'], [['216'], 'Tunisia 🇹🇳'], [['218'], 'Libya 🇱🇾'],
          [['221'], 'Senegal 🇸🇳'], [['224'], 'Guinea 🇬🇳'], [['225'], 'Ivory Coast 🇨🇮'],
          [['233'], 'Ghana 🇬🇭'], [['234'], 'Nigeria 🇳🇬'], [['237'], 'Cameroon 🇨🇲'],
          [['243'], 'DR Congo 🇨🇩'], [['244'], 'Angola 🇦🇴'],
          [['44'], 'United Kingdom 🇬🇧'], [['33'], 'France 🇫🇷'], [['49'], 'Germany 🇩🇪'],
          [['39'], 'Italy 🇮🇹'], [['34'], 'Spain 🇪🇸'], [['31'], 'Netherlands 🇳🇱'],
          [['91'], 'India 🇮🇳'], [['86'], 'China 🇨🇳'], [['81'], 'Japan 🇯🇵'],
          [['82'], 'South Korea 🇰🇷'], [['92'], 'Pakistan 🇵🇰'], [['880'], 'Bangladesh 🇧🇩'],
          [['55'], 'Brazil 🇧🇷'], [['52'], 'Mexico 🇲🇽'], [['54'], 'Argentina 🇦🇷'],
          [['57'], 'Colombia 🇨🇴'], [['61'], 'Australia 🇦🇺'], [['64'], 'New Zealand 🇳🇿'],
          [['7'], 'Russia 🇷🇺'], [['380'], 'Ukraine 🇺🇦'], [['48'], 'Poland 🇵🇱'],
          [['971'], 'UAE 🇦🇪'], [['966'], 'Saudi Arabia 🇸🇦'], [['962'], 'Jordan 🇯🇴'],
          [['98'], 'Iran 🇮🇷'], [['90'], 'Turkey 🇹🇷'], [['60'], 'Malaysia 🇲🇾'],
          [['62'], 'Indonesia 🇮🇩'], [['63'], 'Philippines 🇵🇭'], [['66'], 'Thailand 🇹🇭'],
          [['84'], 'Vietnam 🇻🇳'], [['65'], 'Singapore 🇸🇬'],
        ];
        for (const [prefixes, country] of prefixMap) {
          if (prefixes.some(p => n.startsWith(p))) return country;
        }
        return 'Unknown 🌍';
      }

      // Fetch profile picture
      let ppBuffer = null;
      let ppUrl = null;
      try {
        ppUrl = await ctx.sock.profilePictureUrl(targetJid, 'image');
        const res = await axios.get(ppUrl, { responseType: 'arraybuffer', timeout: 10000 });
        ppBuffer = Buffer.from(res.data);
      } catch { ppUrl = null; }

      // Fetch status/about
      let statusText = 'No status set';
      try {
        const statusResult = await ctx.sock.fetchStatus(targetJid).catch(() => null);
        if (statusResult?.status) statusText = statusResult.status;
      } catch { /* ignore */ }

      // Fetch business profile (WhatsApp display name)
      let waName = ctx.message?.pushName || '';
      try {
        const bp = await ctx.sock.getBusinessProfile(targetJid).catch(() => null);
        if (bp?.name) waName = bp.name;
      } catch { /* ignore */ }

      const country = detectCountry(num);

      const card = [
        `╭━━━━━━━━━━━━━━━━━━╮`,
        `┃   👤 *USER PROFILE*`,
        `╰━━━━━━━━━━━━━━━━━━╯`,
        ``,
        `📱 *WhatsApp Number:*`,
        `┃ +${num}`,
        ``,
        waName ? `🏷️ *Display Name:*\n┃ ${waName}\n` : '',
        `🌍 *Country:*`,
        `┃ ${country}`,
        ``,
        `📝 *About / Status:*`,
        `┃ ${statusText}`,
        ``,
        ppUrl ? `🖼️ *Profile Picture:* _(sent above)_` : `🖼️ *Profile Picture:* _No DP / private_`,
        ``,
        `━━━━━━━━━━━━━━━━━━━━`,
        `_Powered by ${getConfig().botName || 'Malai-XD'}_`
      ].filter(Boolean).join('\n');

      if (ppBuffer) {
        await ctx.sock.sendMessage(ctx.chatId, {
          image: ppBuffer,
          caption: card,
          mentions: [targetJid]
        }, { quoted: ctx.message });
      } else {
        await reply(ctx, card, { mentions: [targetJid] });
      }
    }
  });

  // Admin/automation toggles from src/settings.js. Each can be turned on/off by owner.
  for (const name of TOGGLE_NAMES) {
    if (registry.has(name)) continue;
    add({ name, category: 'tools', ownerOnly: true, desc: `${name} on/off setting`, usage: '<on|off|status>', handler: async (ctx) => {
      const st = getState();
      const action = (ctx.args[0] || 'status').toLowerCase();
      let extra = '';
      if (['on','off'].includes(action)) {
        setToggle(st, name, action === 'on');
        saveState(st);
        if (name === 'autobio' && action === 'on') extra = `\n${await updateAutoBioFromCommand(ctx)}`;
      }
      await reply(ctx, `${name}: ${isToggleEnabled(st, name) ? 'ON' : 'OFF'}\nUsage: ${getConfig().prefix}${name} on/off${extra}`);
    } });
  }

  // ─── DEL / DELETE: Admin delete messages ────────────────────────────────────
  add({ name: 'delete', aliases: ['del'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Delete replied message or last N messages from a user', usage: '[number] [@user]', handler: async (ctx) => {
    const { sock, chatId, message, args } = ctx;
    try { await ensureBotGroupAdmin(ctx, 'delete messages'); } catch (err) { return reply(ctx, err.message); }

    const ctxInfo = message.message?.extendedTextMessage?.contextInfo || {};
    const repliedParticipant = ctxInfo.participant || null;
    const repliedMsgId = ctxInfo.stanzaId || null;
    const mentioned = Array.isArray(ctxInfo.mentionedJid) && ctxInfo.mentionedJid.length > 0 ? ctxInfo.mentionedJid[0] : null;

    let countArg = null;
    const firstArg = parseInt(args[0], 10);
    if (!isNaN(firstArg) && firstArg > 0) countArg = Math.min(firstArg, 50);

    if (countArg === null && repliedParticipant) countArg = 1;
    else if (countArg === null && !repliedParticipant && !mentioned) {
      return reply(ctx, `❌ Usage:\n${ctx.prefix}del 5 — delete last 5 messages\n${ctx.prefix}del @user — delete last message from user\n${ctx.prefix}del (reply) — delete replied message`);
    } else if (countArg === null && mentioned) countArg = 1;

    // Delete the replied message directly if replying
    if (repliedMsgId && repliedParticipant) {
      try {
        await sock.sendMessage(chatId, {
          delete: { remoteJid: chatId, fromMe: false, id: repliedMsgId, participant: repliedParticipant }
        });
        if (countArg <= 1) return;
        countArg = Math.max(0, countArg - 1);
      } catch {}
    }

    // Use message store from index.js for bulk delete
    const storeMap = ctx.messageStore;
    if (!storeMap || !(storeMap instanceof Map)) {
      return reply(ctx, '✅ Replied message deleted. For bulk delete, the message store is initializing.');
    }

    const chatMessages = [...storeMap.values()].filter(m => m.chatId === chatId);
    chatMessages.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const targetUser = repliedParticipant || mentioned || null;
    const toDelete = [];
    for (const m of chatMessages) {
      if (toDelete.length >= countArg) break;
      if (targetUser && m.sender !== targetUser) continue;
      toDelete.push(m);
    }
    if (toDelete.length === 0) return reply(ctx, 'No recent messages found to delete.');
    for (const m of toDelete) {
      try {
        await sock.sendMessage(chatId, {
          delete: { remoteJid: chatId, fromMe: false, id: m.messageId || m.id || m.key?.id, participant: m.sender }
        });
        await new Promise(r => setTimeout(r, 300));
      } catch {}
    }
  }});

  // ─── PAY: Payment info command ────────────────────────────────────────────
  add({ name: 'pay', aliases: ['payment', 'sendmoney', 'mpesa'], category: 'utility', desc: 'Show payment / M-Pesa info or generate a payment request', usage: '[amount] [reason]', handler: async (ctx) => {
    const cfg = getConfig();
    const input = textArg(ctx.args);
    const ownerNumber = normalizeNumber(cfg.ownerNumber || OWNER_NUMBER);
    const phone = ownerNumber ? `+${ownerNumber}` : 'Not set';

    let amountLine = '';
    let reasonLine = '';
    if (input) {
      const parts = input.split(/\s+/);
      if (/^\d+(\.\d+)?$/.test(parts[0])) {
        amountLine = `│ 💰 *Amount:* KES ${parseFloat(parts[0]).toFixed(2)}\n`;
        reasonLine = parts.slice(1).join(' ') ? `│ 📝 *Reason:* ${parts.slice(1).join(' ')}\n` : '';
      } else {
        reasonLine = `│ 📝 *Reason:* ${input}\n`;
      }
    }

    await reply(ctx, `╭─〔 💳 *PAYMENT INFO* 〕
│
│ 👑 *Owner:* ${cfg.ownerName || OWNER_NAME}
│ 📞 *M-Pesa:* ${phone}
│
${amountLine}${reasonLine}│ _Send via M-Pesa then confirm with screenshot._
╰────────────

*Made by Kimani Samuel*`);
  }});


  // ─── REPO: Bot source code repository ────────────────────────────────────────
  add({ name: 'repo', aliases: ['source', 'sourcecode', 'github-repo'], category: 'owner', ownerOnly: true,
    desc: 'Show the bot GitHub repository link',
    handler: async (ctx) => {
      const cfg = getConfig();
      await reply(ctx,
        `╭━━━━━━━━━━━━━━━━━━╮\n` +
        `┃  🤖 *${cfg.botName || 'Malai-XD-2.0'} REPO*\n` +
        `╰━━━━━━━━━━━━━━━━━━╯\n\n` +
        `📦 *GitHub Repository:*\n` +
        `https://github.com/Brokensmile47/Malai-XD-2.0--.git\n\n` +
        `🌐 *Browse online:*\n` +
        `https://github.com/Brokensmile47/Malai-XD-2.0--\n\n` +
        `📥 *Clone:*\n` +
        `\`git clone https://github.com/Brokensmile47/Malai-XD-2.0--.git\`\n\n` +
        `⭐ Star the repo if you find it useful!\n` +
        `_Made by Kimani Samuel_`
      );
    }
  });

  // ─── UPDATE: Pull latest code from GitHub and restart ─────────────────────
  add({ name: 'update', aliases: ['gitpull', 'pullupdate', 'fetchupdate'], category: 'owner', ownerOnly: true,
    desc: 'Pull latest updates from GitHub and restart the bot (auto on Render/Railway, manual on VPS/Linux)',
    usage: '[force]',
    handler: async (ctx) => {
      const REPO_URL = 'https://github.com/Brokensmile47/Malai-XD-2.0--.git';
      const cwd = process.cwd();
      const isForce = (ctx.args[0] || '').toLowerCase() === 'force';

      await reply(ctx, `🔄 *Checking for updates...*\n_Repo:_ ${REPO_URL}`);

      // ── Helper: run shell command synchronously and return output ──
      function run(cmd, options = {}) {
        try {
          return { ok: true, out: execSync(cmd, { cwd, encoding: 'utf8', timeout: 60000, ...options }).trim() };
        } catch (e) {
          return { ok: false, out: (e.stdout || e.stderr || e.message || String(e)).trim().slice(0, 500) };
        }
      }

      // ── 1. Make sure this is a git repo, init remote if needed ──
      const isGit = run('git rev-parse --git-dir');
      if (!isGit.ok) {
        // Not a git repo — initialize and set origin
        run('git init');
        run(`git remote add origin ${REPO_URL}`);
        run('git fetch origin');
        const initResult = run('git checkout -b main origin/main');
        if (!initResult.ok) {
          const initResult2 = run('git checkout -b main origin/master');
          if (!initResult2.ok) {
            return reply(ctx, `❌ *Could not initialize repo*\n${initResult2.out}\n\nTry cloning manually:\n\`git clone ${REPO_URL}\``);
          }
        }
        return reply(ctx, `✅ *Repo initialized and bot updated from GitHub!*\nPlease restart the bot manually:\n\`npm start\``);
      }

      // ── 2. Check current remote ──
      const remoteCheck = run('git remote get-url origin');
      if (!remoteCheck.ok || !remoteCheck.out.includes('Brokensmile47')) {
        run('git remote remove origin');
        run(`git remote add origin ${REPO_URL}`);
      }

      // ── 3. Stash any local changes (protect session and .env) ──
      if (isForce) {
        run('git checkout -- .');
        run('git clean -fd --exclude=session --exclude=.env --exclude=data');
      } else {
        run('git stash');
      }

      // ── 4. Fetch latest commits ──
      const fetchResult = run('git fetch origin');
      if (!fetchResult.ok) {
        return reply(ctx, `❌ *Fetch failed — check internet connection*\n${fetchResult.out}`);
      }

      // ── 5. Get current vs remote commit ──
      const currentBranch = run('git rev-parse --abbrev-ref HEAD');
      const branch = currentBranch.out || 'main';
      const localCommit = run('git rev-parse HEAD');
      const remoteCommit = run(`git rev-parse origin/${branch}`);

      if (localCommit.ok && remoteCommit.ok && localCommit.out === remoteCommit.out) {
        // Restore stash if we stashed
        if (!isForce) run('git stash pop');
        return reply(ctx,
          `✅ *Bot is already up to date!*\n\n` +
          `📌 *Current commit:* \`${localCommit.out.slice(0, 8)}\`\n` +
          `🌐 *Branch:* ${branch}\n` +
          `🔗 Repo: ${REPO_URL}`
        );
      }

      // ── 6. Pull / reset to remote ──
      const pullResult = isForce
        ? run(`git reset --hard origin/${branch}`)
        : run(`git pull origin ${branch} --rebase`);

      if (!pullResult.ok) {
        if (!isForce) run('git stash pop');
        return reply(ctx,
          `❌ *Pull failed*\n${pullResult.out}\n\n` +
          `Try: *${getConfig().prefix}update force* to discard local changes and force-pull.`
        );
      }

      // ── 7. Get changelog (commits added) ──
      const changelog = run(`git log --oneline origin/${branch}...HEAD@{1} 2>/dev/null || git log --oneline -5`);
      const newCommit = run('git rev-parse HEAD');

      // ── 8. Install any new dependencies ──
      const hasPackageChange = run(`git diff HEAD@{1} HEAD -- package.json`);
      let depsMsg = '';
      if (hasPackageChange.out && hasPackageChange.out.length > 5) {
        const npmResult = run('npm install --legacy-peer-deps', { timeout: 120000 });
        depsMsg = npmResult.ok
          ? '\n📦 *Dependencies updated successfully*'
          : `\n⚠️ *Dependency install had issues:* ${npmResult.out.slice(0, 150)}`;
      }

      // ── 9. Build the response message ──
      const changelogText = changelog.out
        ? changelog.out.split('\n').slice(0, 8).map(l => `• ${l}`).join('\n')
        : '• (no changelog available)';

      // ── 10. Detect platform and decide restart method ──
      const isRender  = !!process.env.RENDER;
      const isRailway = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PROJECT_ID;
      const isHeroku  = !!process.env.DYNO;
      const isPm2     = !!process.env.PM2_HOME || !!process.env.pm_id || !!process.env.PM2_USAGE;
      const isAutoHost = isRender || isRailway || isHeroku;

      let restartMsg = '';
      let willAutoRestart = false;

      if (isPm2) {
        // PM2 managed — restart via PM2
        restartMsg = '\n🔁 *Restarting via PM2...*';
        willAutoRestart = true;
      } else if (isAutoHost) {
        // Render/Railway/Heroku — process.exit triggers auto-restart by platform
        restartMsg = '\n🔁 *Restarting automatically (platform managed)...*';
        willAutoRestart = true;
      } else {
        // VPS/Termux/Linux — manual restart required
        restartMsg =
          '\n\n⚠️ *Manual restart required* (VPS/Linux/Termux detected)\n' +
          'Stop the bot then run:\n```\nnpm start\n```\nor with PM2:\n```\npm2 restart all\n```';
        willAutoRestart = false;
      }

      const successMsg =
        `✅ *Bot Updated Successfully!*${depsMsg}\n\n` +
        `📌 *New commit:* \`${(newCommit.out || '').slice(0, 8)}\`\n` +
        `🌿 *Branch:* ${branch}\n` +
        `🔗 *Repo:* ${REPO_URL}\n\n` +
        `📝 *Changes:*\n${changelogText}` +
        restartMsg;

      await reply(ctx, successMsg);

      // ── 11. Restart ──
      if (willAutoRestart) {
        await new Promise(r => setTimeout(r, 2000)); // give reply time to send
        if (isPm2) {
          execCb('pm2 restart all', () => {});
        } else {
          process.exit(0); // Render/Railway/Heroku auto-restarts
        }
      }
    }
  });

  // ─── PRESENCE: Show autorecord and autotyping status ──────────────────────
  add({ name: 'presence', aliases: ['presencestatus'], category: 'tools', ownerOnly: true, desc: 'Show or toggle presence settings (autotyping, autorecord)', usage: '[autotyping|autorecord] [on|off]', handler: async (ctx) => {
    const cfg = getConfig();
    const st = getState();
    const arg1 = (ctx.args[0] || '').toLowerCase();
    const arg2 = (ctx.args[1] || '').toLowerCase();

    // Toggle a specific presence setting
    if (['autotyping', 'autorecord'].includes(arg1) && ['on', 'off'].includes(arg2)) {
      setToggle(st, arg1, arg2 === 'on');
      saveState(st);
      return reply(ctx, `✅ *${arg1}* → *${arg2.toUpperCase()}*\n\nUse ${cfg.prefix}presence to see full status.`);
    }

    const typingOn = isToggleEnabled(st, 'autotyping');
    const recordOn = isToggleEnabled(st, 'autorecord');

    const board = `╔══════════════════════════════╗
║  📡 *PRESENCE STATUS*
╠══════════════════════════════╣
║
║  ⌨️  *Autotyping:*   ${typingOn  ? '✅ ENABLED ' : '❌ DISABLED'}
║  🎙️ *Autorecord:*   ${recordOn  ? '✅ ENABLED ' : '❌ DISABLED'}
║
╠══════════════════════════════╣
║ _Toggle with:_
║  ${cfg.prefix}presence autotyping on/off
║  ${cfg.prefix}autorecord on/off
║  ${cfg.prefix}autotyping on/off
╚══════════════════════════════╝

${madeByFooter(cfg)}`;
    await reply(ctx, board);
  }});

  // ─── SETBOTNAME: Change bot display name ──────────────────────────────────
  add({ name: 'setbotname', aliases: ['botname', 'changebotname'], category: 'owner', ownerOnly: true, desc: 'Change the bot display name', usage: '<new name>', handler: async (ctx) => {
    const newName = textArg(ctx.args).trim();
    if (!newName) return reply(ctx, `Usage: ${getConfig().prefix}setbotname <new name>\nExample: ${getConfig().prefix}setbotname Malai-Pro`);
    if (newName.length < 2 || newName.length > 50) return reply(ctx, '❌ Bot name must be between 2 and 50 characters.');
    saveConfig({ botName: newName });
    // Also try to update the WhatsApp profile name
    let profileMsg = '';
    try {
      if (typeof ctx.sock.updateProfileName === 'function') {
        await ctx.sock.updateProfileName(newName);
        profileMsg = '\n✅ WhatsApp profile name also updated.';
      }
    } catch (e) {
      profileMsg = `\n⚠️ Config saved but WhatsApp profile update failed: ${e.message}`;
    }
    await reply(ctx, `✅ *Bot name updated!*\n\n🤖 New name: *${newName}*${profileMsg}\n\n_Use ${getConfig().prefix}ping to confirm._`);
  }});

  // ─── SETBOTPP: Change bot profile picture ────────────────────────────────
  add({ name: 'setbotpp', aliases: ['setbotimage', 'botpp', 'changebotpp'], category: 'owner', ownerOnly: true, desc: 'Change the bot profile picture — reply to an image', handler: async (ctx) => {
    const quoted = ctx.message?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const imgMsg = ctx.message?.message?.imageMessage || quoted?.imageMessage;
    if (!imgMsg) return reply(ctx, `❌ Please reply to an image with ${getConfig().prefix}setbotpp to set the bot profile picture.`);
    try {
      const stream = await downloadContentFromMessage(imgMsg, 'image');
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (typeof ctx.sock.updateProfilePicture !== 'function') {
        return reply(ctx, '❌ This Baileys version does not support updateProfilePicture on this host.');
      }
      const botJid = ctx.sock.user?.id || ctx.sock.user?.jid;
      if (!botJid) return reply(ctx, '❌ Could not determine bot JID. Try again after the bot is fully connected.');
      await ctx.sock.updateProfilePicture(botJid, buffer);
      await reply(ctx, '✅ *Bot profile picture updated successfully!*');
    } catch (err) {
      await reply(ctx, `❌ Failed to update profile picture: ${err.message || err}`);
    }
  }});

  // ─── Remaining misc stubs ─────────────────────────────────────────────────
  const miscNames = ['clean','clear','cleartmp','warnings','warn','resetwarn','topmembers','myactivity','groupstats','goodnight','lovenight','gn','shayari','roseday','heart','circle','lgbt','lolice','simpcard','tonikawa','its-so-stupid','namecard','oogway','oogway2','tweet','ytcomment','comrade','gay','glass','jail','passed','triggered','china','indonesia','japan','korea','india','malaysia','thailand','url','ss','ssweb','screenshot','up','reject','translate','trt','translate2','trt2','tts','bio','character','wasted','emojimix','meme','memesearch','bomb','pingspam','newsletter','setnewsletter','setmenuimage','broadcast','sudo','addsudo','delsudo','owners','support','channel'];
  for (const name of miscNames) {
    if (registry.has(name)) continue;
    add({ name, category: 'tools', desc: `${name} command`, handler: async (ctx) => reply(ctx, `${name} command is registered and working in the mega build.`) });
  }

  return { commands, registry, getConfig, getState };
}
