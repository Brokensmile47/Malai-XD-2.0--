import { normalizeNumber, randomChoice } from './utils.js';

export const OWNER_NUMBER = normalizeNumber(process.env.OWNER_NUMBER || '254105197055');
export const OWNER_NAME = process.env.OWNER_NAME || 'Malaitechx';
export const BOT_NAME = process.env.BOT_NAME || 'Malai-XD-2.0';
export const DEFAULT_PREFIX = process.env.PREFIX || '.';

export const TOGGLE_DEFINITIONS = [
  { name: 'greet', default: false, desc: 'Private auto-greet after the owner has not replied for the delay.' },
  { name: 'commandreact', aliases: ['cmdreact'], default: true, desc: 'React to supported commands with matching emojis.' },
  { name: 'autobio', aliases: ['autoprofile', 'autostatusbio'], default: false, desc: 'Auto-update the bot WhatsApp bio with bot name, active time, date, and rocket emoji.' },
  { name: 'autostatus', aliases: ['statusreact'], default: false, desc: 'React to WhatsApp status posts with rotating emojis.' },
  { name: 'autoreact', default: false, desc: 'General auto reaction switch for future reactions.' },
  { name: 'antilink', default: false, desc: 'Anti-link placeholder toggle.' },
  { name: 'antitag', default: false, desc: 'Anti-tag placeholder toggle.' },
  { name: 'antibadword', default: false, desc: 'Anti-badword placeholder toggle.' },
  { name: 'antidelete', default: false, desc: 'Anti-delete placeholder toggle.' },
  { name: 'antidelete_status', default: false, desc: 'Anti-delete status placeholder toggle.' },
  { name: 'antideleteviewonce', default: false, desc: 'Anti view-once delete placeholder toggle.' },
  { name: 'antistatus', default: false, desc: 'Status blocking placeholder toggle.' },
  { name: 'anticall', default: false, desc: 'Anti-call placeholder toggle.' },
  { name: 'pmblocker', default: false, desc: 'Private-message blocker placeholder toggle.' },
  { name: 'autoread', default: false, desc: 'Auto-read placeholder toggle.' },
  { name: 'autotyping', default: false, desc: 'Show fake typing/composing presence in groups and private chats when messages arrive.' },
  { name: 'autorecord', default: false, desc: 'Show fake recording-audio presence in groups and private chats when messages arrive.' },
  { name: 'welcome', default: false, desc: 'Welcome message placeholder toggle.' },
  { name: 'goodbye', default: false, desc: 'Goodbye message placeholder toggle.' },
  { name: 'mention', default: false, desc: 'Mention reply placeholder toggle.' },
  { name: 'antiword', default: false, desc: 'Anti-word placeholder toggle.' },
  { name: 'antigroupmention', default: false, desc: 'Anti group mention placeholder toggle.' },
  { name: 'autosticker', default: false, desc: 'Auto sticker placeholder toggle.' }
];

export const TOGGLE_NAMES = TOGGLE_DEFINITIONS.map(item => item.name);
export const TOGGLE_ALIASES = Object.fromEntries(
  TOGGLE_DEFINITIONS.flatMap(item => (item.aliases || []).map(alias => [alias, item.name]))
);

export const DEFAULT_TOGGLES = Object.fromEntries(TOGGLE_DEFINITIONS.map(item => [item.name, item.default]));

export const COMMAND_REACTIONS = {
  kick: '🦵',
  remove: '🦵',
  add: '➕',
  approve: '✅',
  approveall: '✅',
  accept: '✅',
  block: '🚫',
  unblock: '🔓',
  setprefix: '✍️',
  prefixset: '✍️',
  groupinfo: '👥',
  ginfo: '👥',
  promote: '⬆️',
  demote: '⬇️',
  ban: '🚫',
  unban: '✅',
  play: '🎵',
  song: '🎵',
  song2: '🎵',
  music: '🎵',
  ytmp3: '🎧',
  video: '🎬',
  ytmp4: '🎥',
  youtube: '▶️',
  pair: '🔐',
  settings: '⚙️',
  autobio: '🤖',
  autoprofile: '🤖',
  autostatusbio: '🤖',
  greet: '👋',
  owner: '👑',
  menu: '📜',
  allmenu: '📚',
  alive: '🤖',
  ping: '🏓',
  sticker: '✨',
  s: '✨',
  tagall: '📣',
  hidetag: '📣',
  open: '🔓',
  close: '🔒',
  restart: '♻️'
};

export const DEFAULT_COMMAND_REACTION = '✅';

export const STATUS_REACTIONS = [
  '🇰🇪', '🔥', '💚', '❤️', '😂', '😍', '🥳', '👏', '🤩', '😎', '💯', '✨', '🙌', '🫶', '⚡'
];


export function getDateTimeParts(timeZone = process.env.TIME_ZONE || process.env.TZ || 'Africa/Nairobi') {
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(now);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(now);
  return { date, time, timeZone };
}

export function formatAutoBio(botName = BOT_NAME, timeZone = process.env.TIME_ZONE || process.env.TZ || 'Africa/Nairobi') {
  const { date, time } = getDateTimeParts(timeZone);
  return `🤖 ${botName} is active ⏰ ${time} 📅 ${date} 🚀`;
}

export function resolveToggleName(name = '') {
  const key = String(name).trim().toLowerCase();
  return TOGGLE_NAMES.includes(key) ? key : TOGGLE_ALIASES[key];
}

export function mergeDefaultToggles(toggles = {}) {
  return { ...DEFAULT_TOGGLES, ...toggles };
}

export function isToggleEnabled(state, name) {
  const realName = resolveToggleName(name);
  if (!realName) return false;
  const toggles = mergeDefaultToggles(state?.toggles || {});
  return Boolean(toggles[realName]);
}

export function setToggle(state, name, enabled) {
  const realName = resolveToggleName(name);
  if (!realName) return null;
  state.toggles = mergeDefaultToggles(state.toggles || {});
  state.toggles[realName] = Boolean(enabled);
  return realName;
}

export function formatSettings(state, prefix = DEFAULT_PREFIX) {
  const toggles = mergeDefaultToggles(state?.toggles || {});
  const rows = TOGGLE_DEFINITIONS.map((item, index) => {
    const status = toggles[item.name] ? 'ON ' : 'OFF';
    return `${String(index + 1).padStart(2, '0')}. ${status}  ${prefix}${item.name} on/off — ${item.desc}`;
  });
  return [
    `╭━━━〔 ${BOT_NAME} SETTINGS 〕━━━╮`,
    `┃ Use: ${prefix}settings <name> on/off`,
    `┃ Example: ${prefix}settings greet on`,
    '╰━━━━━━━━━━━━━━━━━━━━╯',
    '',
    ...rows
  ].join('\n');
}

export function commandReaction(commandName = '') {
  const key = String(commandName).trim().toLowerCase();
  return COMMAND_REACTIONS[key] || DEFAULT_COMMAND_REACTION;
}

export function statusReaction(seed = '') {
  if (!seed) return randomChoice(STATUS_REACTIONS);
  let sum = 0;
  for (const char of String(seed)) sum += char.codePointAt(0) || 0;
  return STATUS_REACTIONS[sum % STATUS_REACTIONS.length];
}
