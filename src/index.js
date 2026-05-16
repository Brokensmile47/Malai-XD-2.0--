import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { URL } from 'url';
import pino from 'pino';
import axios from 'axios';
import qrcode from 'qrcode-terminal';
import { Boom } from '@hapi/boom';
import { buildCommands } from './commands.js';
import { unwrapMessage, extractText, normalizeNumber, isAdmin, mentionedJids, runtime } from './utils.js';
import { browserConfig, cleanPhoneNumber, createPairingManager, loginMethod, pairInstructions, promptForPairingNumber, validatePairingNumber } from './pairing.js';
import { BOT_NAME, OWNER_NUMBER, commandReaction, formatAutoBio, isToggleEnabled, statusReaction } from './settings.js';

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = await import('@whiskeysockets/baileys');

const { commands, registry, getConfig, getState } = buildCommands();
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });
const sessionDir = process.env.SESSION_DIR || './session';
fs.mkdirSync(sessionDir, { recursive: true });

let activePairingManager = null;
const pendingGreetTimers = new Map();
let statusReactionCount = 0;
let lastConnectedNoticeAt = 0;
let autoBioTimer = null;
let lastAutoBioText = '';
const presenceTimers = new Map();

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload, null, 2));
}

function startWeb() {
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (url.pathname === '/code' || url.pathname === '/pair') {
      if (String(process.env.PAIRING_WEB_ENABLED || 'true').toLowerCase() === 'false') {
        sendJson(res, 403, { ok: false, error: 'Web pairing is disabled by PAIRING_WEB_ENABLED=false.' });
        return;
      }
      try {
        const requiredToken = process.env.PAIRING_AUTH_TOKEN || '';
        const suppliedToken = url.searchParams.get('token') || req.headers['x-pairing-token'] || '';
        if (requiredToken && suppliedToken !== requiredToken) {
          sendJson(res, 401, { ok: false, error: 'Missing or invalid pairing token.' });
          return;
        }
        const number = validatePairingNumber(url.searchParams.get('number') || url.searchParams.get('phone') || '');
        if (!activePairingManager) throw new Error('Pairing manager is not ready yet. Start the bot and try again.');
        const result = await activePairingManager.requestPairing(number, 'web');
        sendJson(res, 200, {
          ok: true,
          number: result.number,
          code: result.code,
          instructions: pairInstructions(result.code)
        });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message || String(err) });
      }
      return;
    }

    sendJson(res, 200, {
      ok: true,
      bot: getConfig().botName,
      commands: commands.length,
      uptime: process.uptime(),
      pairing: {
        loginMethod: loginMethod(),
        endpoint: '/code?number=254105197055',
        webEnabled: String(process.env.PAIRING_WEB_ENABLED || 'true').toLowerCase() !== 'false'
      }
    });
  });
  server.listen(port, () => console.log(`Health and pairing server running on port ${port}`));
}

function isOwnerJid(jid) {
  const cfg = getConfig();
  const sender = normalizeNumber(jid);
  const owner = normalizeNumber(cfg.ownerNumber);
  if (!owner) return false;
  if (sender === owner) return true;
  const sudo = (process.env.SUDO_USERS || '').split(',').map(normalizeNumber).filter(Boolean);
  return sudo.includes(sender);
}


function chatIsPrivate(chatId = '') {
  return chatId.endsWith('@s.whatsapp.net') || chatId.endsWith('@lid');
}

async function safeReact(sock, message, emoji) {
  if (!emoji || !message?.key) return;
  try {
    await sock.sendMessage(message.key.remoteJid, { react: { text: emoji, key: message.key } });
  } catch (err) {
    console.warn(`Reaction failed: ${err.message || err}`);
  }
}

async function reactToCommand(sock, message, commandName) {
  const state = getState();
  if (!isToggleEnabled(state, 'commandreact')) return;
  await safeReact(sock, message, commandReaction(commandName));
}

async function handleStatusMessage(sock, rawMessage) {
  const message = unwrapMessage(rawMessage);
  if (message?.key?.remoteJid !== 'status@broadcast' || message.key?.fromMe) return;
  const state = getState();
  if (!isToggleEnabled(state, 'autostatus')) return;
  const participant = message.key.participant;
  const emoji = statusReaction(`${message.key.id || ''}:${participant || ''}:${statusReactionCount++}`);
  try {
    await sock.sendMessage('status@broadcast', {
      react: { text: emoji, key: message.key }
    }, participant ? { statusJidList: [participant] } : undefined);
  } catch (err) {
    console.warn(`Status reaction failed: ${err.message || err}`);
  }
}

async function sendAutoPresence(sock, chatId, state = getState()) {
  if (!chatId || chatId === 'status@broadcast') return;
  const record = isToggleEnabled(state, 'autorecord');
  const typing = isToggleEnabled(state, 'autotyping');
  if (!record && !typing) return;

  const presenceType = record ? 'recording' : 'composing';
  const durationMs = Math.max(2000, Number(process.env.AUTO_PRESENCE_DURATION_MS || 12000));

  try {
    if (typeof sock.presenceSubscribe === 'function') await sock.presenceSubscribe(chatId).catch(() => {});
    await sock.sendPresenceUpdate(presenceType, chatId);
  } catch (err) {
    console.warn(`Auto presence failed: ${err.message || err}`);
    return;
  }

  const oldTimer = presenceTimers.get(chatId);
  if (oldTimer) clearTimeout(oldTimer);
  presenceTimers.set(chatId, setTimeout(async () => {
    presenceTimers.delete(chatId);
    try {
      await sock.sendPresenceUpdate('paused', chatId);
    } catch {}
  }, durationMs));
}

function cancelPrivateGreet(chatId) {
  const timer = pendingGreetTimers.get(chatId);
  if (timer) clearTimeout(timer);
  pendingGreetTimers.delete(chatId);
}

function schedulePrivateGreet(sock, message, chatId, sender, fromMe) {
  const state = getState();
  if (!isToggleEnabled(state, 'greet')) return;
  if (!chatIsPrivate(chatId) || chatId === 'status@broadcast') return;

  // A reply from the owner/bot in this private chat cancels the pending auto-greet.
  if (fromMe || isOwnerJid(sender)) {
    cancelPrivateGreet(chatId);
    return;
  }

  cancelPrivateGreet(chatId);
  const delayMs = Math.max(1000, Number(process.env.GREET_DELAY_MS || 20 * 60 * 1000));
  const cfg = getConfig();
  const timer = setTimeout(async () => {
    pendingGreetTimers.delete(chatId);
    try {
      await sock.sendMessage(chatId, {
        text: `👋 Hello, this is ${cfg.botName}.\n\nThe owner has not replied for about 20 minutes. Please leave your message and they will get back to you soon.\n\nOwner contact: +${normalizeNumber(cfg.ownerNumber || OWNER_NUMBER)}`
      }, { quoted: message });
    } catch (err) {
      console.warn(`Private greet failed: ${err.message || err}`);
    }
  }, delayMs);
  pendingGreetTimers.set(chatId, timer);
}

async function sendConnectedNotice(sock) {
  if (String(process.env.CONNECT_NOTIFY || 'true').toLowerCase() === 'false') return;
  const now = Date.now();
  if (now - lastConnectedNoticeAt < 120000) return;
  lastConnectedNoticeAt = now;

  const cfg = getConfig();
  const botNumber = normalizeNumber(sock.user?.id || sock.user?.jid || '');
  const ownerNumber = normalizeNumber(cfg.ownerNumber || OWNER_NUMBER);
  const recipients = new Set();
  if (botNumber) recipients.add(`${botNumber}@s.whatsapp.net`);
  if (ownerNumber) recipients.add(`${ownerNumber}@s.whatsapp.net`);

  const text = `✅ ${cfg.botName || BOT_NAME} connected successfully.\nRuntime: ${runtime()}\nOwner: +${ownerNumber}`;
  for (const jid of recipients) {
    try {
      await sock.sendMessage(jid, { text });
    } catch (err) {
      console.warn(`Connected notice failed for ${jid}: ${err.message || err}`);
    }
  }
}

async function updateAutoBio(sock, force = false) {
  const state = getState();
  if (!isToggleEnabled(state, 'autobio')) return;
  const cfg = getConfig();
  const bio = formatAutoBio(cfg.botName || BOT_NAME, cfg.timeZone);
  if (!force && bio === lastAutoBioText) return;
  if (typeof sock.updateProfileStatus !== 'function') {
    console.warn('Autobio is enabled, but updateProfileStatus is not available on this Baileys socket.');
    return;
  }
  try {
    await sock.updateProfileStatus(bio);
    lastAutoBioText = bio;
    console.log(`Autobio updated: ${bio}`);
  } catch (err) {
    console.warn(`Autobio update failed: ${err.message || err}`);
  }
}

function startAutoBio(sock) {
  if (autoBioTimer) clearInterval(autoBioTimer);
  const intervalMs = Math.max(60000, Number(process.env.AUTOBIO_INTERVAL_MS || 10 * 60 * 1000));
  updateAutoBio(sock, true).catch(err => console.warn(`Autobio startup failed: ${err.message || err}`));
  autoBioTimer = setInterval(() => {
    updateAutoBio(sock).catch(err => console.warn(`Autobio timer failed: ${err.message || err}`));
  }, intervalMs);
}

async function sendError(sock, chatId, message, err) {
  console.error('Command error:', err);
  await sock.sendMessage(chatId, { text: `Command failed: ${err.message || err}` }, { quoted: message }).catch(() => {});
}

async function handleMessage(sock, rawMessage) {
  const message = unwrapMessage(rawMessage);
  if (!message?.message || message.key?.remoteJid === 'status@broadcast') return;
  const chatId = message.key.remoteJid;
  const sender = message.key.participant || message.key.remoteJid;
  const isGroup = chatId.endsWith('@g.us');
  const fromMe = Boolean(message.key.fromMe);
  const rawText = extractText(message).trim();
  const state = getState();
  if (!fromMe) await sendAutoPresence(sock, chatId, state);
  schedulePrivateGreet(sock, message, chatId, sender, fromMe);
  if (!rawText) return;

  const cfg = getConfig();
  const prefix = cfg.prefix || '.';
  if (state.banned?.includes(sender) && !isOwnerJid(sender)) return;

  if (!rawText.startsWith(prefix)) {
    const learned = state.learned?.[rawText.toLowerCase()];
    if (learned && (cfg.publicMode || isOwnerJid(sender) || fromMe)) {
      await sock.sendMessage(chatId, { text: learned }, { quoted: message });
    }
    return;
  }

  if (!cfg.publicMode && !isOwnerJid(sender) && !fromMe) return;

  const body = rawText.slice(prefix.length).trim();
  if (!body) return;
  let [cmdNameRaw, ...args] = body.split(/\s+/);
  let cmdName = cmdNameRaw.toLowerCase();
  let command = registry.get(cmdName);

  // Support compact owner command syntax such as .setprefix+
  // After it is saved, the next commands must use the new prefix, for example +menu.
  if (!command) {
    const compactPrefixChange = body.match(/^(setprefix|prefixset|newprefix)(.+)$/i);
    if (compactPrefixChange) {
      cmdName = 'setprefix';
      args = [compactPrefixChange[2]];
      command = registry.get(cmdName);
    }
  }

  if (!command) {
    await sock.sendMessage(chatId, { text: `Unknown command: ${prefix}${cmdName}\nUse ${prefix}menu.` }, { quoted: message });
    return;
  }

  const owner = isOwnerJid(sender) || fromMe;
  if (command.ownerOnly && !owner) {
    await sock.sendMessage(chatId, { text: 'This command is owner-only.' }, { quoted: message });
    return;
  }
  if (command.groupOnly && !isGroup) {
    await sock.sendMessage(chatId, { text: 'This command only works in groups.' }, { quoted: message });
    return;
  }
  if (command.adminOnly && isGroup && !owner) {
    const admin = await isAdmin(sock, chatId, sender);
    if (!admin) {
      await sock.sendMessage(chatId, { text: 'This command requires group admin permission.' }, { quoted: message });
      return;
    }
  }

  const ctx = {
    sock, message, chatId, sender, isGroup, args,
    rawText, body, commandName: cmdName, prefix, pushName: message.pushName || '',
    owner, mentions: mentionedJids(message)
  };
  try {
    await reactToCommand(sock, message, cmdName);
    await sendAutoPresence(sock, chatId, state);
    await command.handler(ctx);
    await sock.sendPresenceUpdate('paused', chatId).catch(() => {});
  } catch (err) {
    await sendError(sock, chatId, message, err);
  }
}

// ─── VV2: Auto-forward view-once to owner's saved messages ─────────────────
async function handleViewOnceAutoForward(sock, rawMessage) {
  try {
    const st = getState();
    if (st.groupSettings?._vv2 === false) return; // off if explicitly disabled
    const message = unwrapMessage(rawMessage);
    if (!message?.message) return;
    const chatId = message.key.remoteJid;
    const fromMe = Boolean(message.key.fromMe);
    if (fromMe) return; // don't process own messages
    const sender = message.key.participant || message.key.remoteJid;
    const msg = message.message;
    const viewOnceMsg = msg.viewOnceMessage?.message || msg.viewOnceMessageV2?.message || msg.viewOnceMessageV2Extension?.message;
    if (!viewOnceMsg) return;
    const imgMsg = viewOnceMsg.imageMessage;
    const vidMsg = viewOnceMsg.videoMessage;
    if (!imgMsg && !vidMsg) return;

    const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
    const cfg = getConfig();
    const ownerJid = `${normalizeNumber(cfg.ownerNumber || OWNER_NUMBER)}@s.whatsapp.net`;
    const selfJid = sock.user?.id || sock.user?.jid || ownerJid;

    // Build info text
    const senderNumber = `+${normalizeNumber(sender)}`;
    const senderName = message.pushName || senderNumber;
    const isGroup = chatId.endsWith('@g.us');
    let source = 'Private DM';
    if (isGroup) {
      try {
        const meta = await sock.groupMetadata(chatId);
        source = `Group: ${meta.subject}`;
      } catch { source = `Group: ${chatId}`; }
    }
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-GB', { timeZone: cfg.timeZone || 'Africa/Nairobi', day: '2-digit', month: 'short', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-GB', { timeZone: cfg.timeZone || 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const caption = `📸 *View-Once Received*\n\n👤 *Sender:* ${senderName}\n📞 *Number:* ${senderNumber}\n📍 *From:* ${source}\n📅 *Date:* ${dateStr}\n⏰ *Time:* ${timeStr}`;

    if (imgMsg) {
      const stream = await downloadContentFromMessage(imgMsg, 'image');
      let buf = Buffer.from([]);
      for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
      await sock.sendMessage(selfJid, { image: buf, caption });
    } else if (vidMsg) {
      const stream = await downloadContentFromMessage(vidMsg, 'video');
      let buf = Buffer.from([]);
      for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
      await sock.sendMessage(selfJid, { video: buf, caption });
    }
  } catch (err) {
    // Silent fail — vv2 should never surface errors
  }
}

// ─── WELCOME: Send welcome message with DP ─────────────────────────────────
async function handleGroupWelcome(sock, groupId, participants) {
  const cfg = getConfig();
  let meta;
  try { meta = await sock.groupMetadata(groupId); } catch { return; }
  const groupName = meta.subject;
  const groupDesc = meta.desc || 'No description available.';
  const memberCount = meta.participants?.length || 0;

  for (const participant of participants) {
    const jidStr = typeof participant === 'string' ? participant : (participant.id || participant.toString());
    const number = `+${normalizeNumber(jidStr)}`;
    const pushName = (typeof participant === 'object' && participant.pushName) || number;

    // Fetch DP
    let ppBuffer = null;
    try {
      const ppUrl = await sock.profilePictureUrl(jidStr, 'image');
      if (ppUrl) {
        const { data } = await axios.get(ppUrl, { responseType: 'arraybuffer', timeout: 10000 });
        ppBuffer = Buffer.from(data);
      }
    } catch { /* default: no image */ }

    const welcomeMsg = `╭╼━≪• 🎉 *WELCOME* •≫━╾╮
┃ 👋 Hello *${pushName}*!
┃ 📞 Number: ${number}
┃ 🏡 Group: *${groupName}*
┃ 👥 Members: *${memberCount}*
╰━━━━━━━━━━━━━━━━╯

📋 *Group Description:*
${groupDesc}

We are glad to have you here! 🥳
Please read the group rules and enjoy your stay.

*Made by Kimani Samuel*`;

    try {
      if (ppBuffer) {
        await sock.sendMessage(groupId, {
          image: ppBuffer,
          caption: welcomeMsg,
          mentions: [jidStr]
        });
      } else {
        await sock.sendMessage(groupId, { text: welcomeMsg, mentions: [jidStr] });
      }
    } catch (err) {
      console.warn('Welcome send error:', err.message);
    }
  }
}

// ─── GOODBYE: Send goodbye message with DP ──────────────────────────────────
async function handleGroupGoodbye(sock, groupId, participants) {
  let meta;
  try { meta = await sock.groupMetadata(groupId); } catch { return; }
  const groupName = meta.subject;

  for (const participant of participants) {
    const jidStr = typeof participant === 'string' ? participant : (participant.id || participant.toString());
    const number = `+${normalizeNumber(jidStr)}`;
    const pushName = (typeof participant === 'object' && participant.pushName) || number;

    // Fetch DP
    let ppBuffer = null;
    try {
      const ppUrl = await sock.profilePictureUrl(jidStr, 'image');
      if (ppUrl) {
        const { data } = await axios.get(ppUrl, { responseType: 'arraybuffer', timeout: 10000 });
        ppBuffer = Buffer.from(data);
      }
    } catch { /* default: no image */ }

    const goodbyeMsg = `╭╼━≪• 👋 *GOODBYE* •≫━╾╮
┃ 😢 *${pushName}* has left
┃ 📞 Number: ${number}
┃ 🏡 Group: *${groupName}*
╰━━━━━━━━━━━━━━━━╯

💔 We will miss you! 
Goodbye and take care! 👋

*Made by Kimani Samuel*`;

    try {
      if (ppBuffer) {
        await sock.sendMessage(groupId, {
          image: ppBuffer,
          caption: goodbyeMsg,
          mentions: [jidStr]
        });
      } else {
        await sock.sendMessage(groupId, { text: goodbyeMsg, mentions: [jidStr] });
      }
    } catch (err) {
      console.warn('Goodbye send error:', err.message);
    }
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: browserConfig(),
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    }
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && loginMethod() === 'qr') {
      console.log('Scan this QR in WhatsApp > Linked devices:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log(`${getConfig().botName} connected with ${commands.length} commands.`);
      await sendConnectedNotice(sock);
      startAutoBio(sock);
    }
    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`Connection closed. code=${statusCode} reconnect=${shouldReconnect}`);
      if (shouldReconnect) setTimeout(startBot, 3000);
      else console.log('Logged out. Delete the session folder and start again to relink.');
    }
  });

  activePairingManager = createPairingManager(sock, { logger: console });

  if (!sock.authState.creds.registered && loginMethod() !== 'qr') {
    const envNumber = process.env.PAIRING_NUMBER || process.env.OWNER_NUMBER || process.argv.find(arg => /^--number=/.test(arg))?.split('=')[1] || '';
    const number = await promptForPairingNumber(envNumber).catch(err => {
      console.error(`Pairing number error: ${err.message || err}`);
      return '';
    });

    if (cleanPhoneNumber(number)) {
      setTimeout(async () => {
        try {
          await activePairingManager.requestPairing(number, 'startup');
        } catch (err) {
          console.error('Pairing code failed. Check the number, delete any broken session, or try LOGIN_METHOD=qr.', err.message || err);
        }
      }, 3000);
    } else {
      console.log('Pairing mode is active, but no number was set.');
      console.log('Set PAIRING_NUMBER or OWNER_NUMBER, start with --number=15551234567, or visit /code?number=15551234567 on the hosted app.');
    }
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      await handleStatusMessage(sock, msg);
      await handleViewOnceAutoForward(sock, msg);
      await handleMessage(sock, msg);
    }
  });

  // ─── GROUP EVENTS: Welcome & Goodbye ─────────────────────────────────────
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    try {
      const st = getState();
      const groupSettings = st.groupSettings || {};
      const grpCfg = groupSettings[id] || {};

      if (action === 'add' && grpCfg.welcome) {
        await handleGroupWelcome(sock, id, participants);
      }
      if ((action === 'remove' || action === 'leave') && grpCfg.goodbye) {
        await handleGroupGoodbye(sock, id, participants);
      }
    } catch (err) {
      console.warn('Group participant event error:', err.message || err);
    }
  });
}

startWeb();
startBot().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
