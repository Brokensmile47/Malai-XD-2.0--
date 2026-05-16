# Malai-XD-2.0 Asaia Mega WhatsApp Bot

**Version 1.0.5 Malai build:** pairing remains fixed, and this build adds the branded image menu, `⭐ Made by Kimani Samuel ⭐` menu footer, autobio, runtime prefix switching, block/unblock, add/kick/promote/demote by number or mention, pending join request approval, richer group info with group DP, owner contact, settings toggles, private greet, command reactions, autostatus reactions, YouTube audio/video downloads, and connected notifications.

A merged WhatsApp multi-command bot built from the uploaded **KnightBot-Mini**, **Knightbot-MD**, **NOVA-XMD**, and **Malaitechx** zips.

The final build uses a clean Baileys ESM launcher so it runs on modern Node versions without the CommonJS/ESM startup crash found in the uploaded sources. It includes **420 primary commands** and **494 total triggers including aliases**.

## What was updated

- Rebuilt the launcher with ESM-compatible Baileys loading.
- Added Node 18+ polyfills required by modern Baileys/undici.
- Added pairing-code and QR login modes.
- Reworked pairing with Knightbot-MD style phone-number cleaning, code formatting, interactive fallback, and cross-platform browser tuples.
- Added hosted pairing endpoints: `/code?number=...` and `/pair?number=...`.
- Added a small HTTP health server for Render/Railway uptime checks.
- Added Linux, Termux, VPS, Render, Railway, Docker, and Procfile support.
- Added a styled full image menu using `assets/bot_image.jpg`, command reaction emojis, read-more spacing, descriptions, and `⭐ Made by Kimani Samuel ⭐` footer branding.
- Added `.setprefix+` compact prefix switching, so the bot immediately changes from `.` to `+` or any chosen prefix.
- Added `.autobio on/off`; when enabled, the bot bio updates with `🤖 BotName is active ⏰ time 📅 date 🚀`.
- Added group-management commands: `.add`, `.kick`, `.promote`, `.demote`, `.approve`, `.block`, `.unblock`, and enhanced `.groupinfo` with group DP, description, admins, and members.
- Added safe command validation and an offline-safe command registry with 200+ commands.
- Removed old session/cache files from the final zip.

## Requirements

- Node.js 18.17+ recommended. Node 20 is best for Render/Railway.
- A WhatsApp account for linking.
- Optional: ffmpeg/sharp if you extend media conversion commands.


## Version 1.0.5 updates

- `.menu` is now a single compact organised category menu instead of many split menu messages. It starts with the bot image, then shows numbered categories like General, Owner, Group, AI, Downloads, Tools, Fun, Games, and Anime.
- Use `.allmenu` when you want the full long command list, or use category menus like `.generalmenu`, `.ownermenu`, and `.groupmenu`.
- `autotyping` now sends fake typing/composing presence in both groups and private chats when enabled.
- `autorecord` now sends fake recording-audio presence in both groups and private chats when enabled. If both are on, recording takes priority.
- `.kick`, `.promote`, and `.demote` now resolve mentions, replies, and typed numbers more safely against group metadata and warn clearly when the bot is not group admin.

## Quick start on Linux / VPS / Discord VPS panel

```bash
unzip malai-xd-2-asaia-mega-whatsapp-bot.zip
cd malai-xd-2-asaia-mega-whatsapp-bot
cp .env.example .env
nano .env
npm install --legacy-peer-deps
npm start
```

For a VPS with PM2:

```bash
npm install -g pm2
pm2 start start.js --name malai-xd-2-bot
pm2 save
```


## Version 1.0.5 updates

- `.menu` is now a single compact organised category menu instead of many split menu messages. It starts with the bot image, then shows numbered categories like General, Owner, Group, AI, Downloads, Tools, Fun, Games, and Anime.
- Use `.allmenu` when you want the full long command list, or use category menus like `.generalmenu`, `.ownermenu`, and `.groupmenu`.
- `autotyping` now sends fake typing/composing presence in both groups and private chats when enabled.
- `autorecord` now sends fake recording-audio presence in both groups and private chats when enabled. If both are on, recording takes priority.
- `.kick`, `.promote`, and `.demote` now resolve mentions, replies, and typed numbers more safely against group metadata and warn clearly when the bot is not group admin.

## Quick start on Termux

```bash
pkg update -y
pkg install nodejs git nano -y
unzip malai-xd-2-asaia-mega-whatsapp-bot.zip
cd malai-xd-2-asaia-mega-whatsapp-bot
cp .env.example .env
nano .env
npm install --legacy-peer-deps
npm start
```

## Pairing-code login

In `.env`, use your full international WhatsApp number without `+`, spaces, or leading zero:

```env
LOGIN_METHOD=pair
PAIRING_NUMBER=254105197055
OWNER_NUMBER=254105197055
```

Run:

```bash
npm start
```

You can also pass the number directly:

```bash
node start.js --pair --number=15551234567
```

Then enter the printed pairing code in WhatsApp:

WhatsApp → Linked devices → Link a device → Link with phone number instead.

### Hosted pairing endpoint

When the bot is running on Render/Railway/VPS and has no saved session yet, open:

```text
https://your-app.example.com/code?number=15551234567
```

The endpoint returns JSON with the pairing code and the same phone-linking instructions. `/pair?number=...` works too.

For a private endpoint, set:

```env
PAIRING_AUTH_TOKEN=your-secret-token
```

Then open:

```text
https://your-app.example.com/code?number=15551234567&token=your-secret-token
```

Set `PAIRING_WEB_ENABLED=false` to disable web pairing completely.

## QR login

```bash
LOGIN_METHOD=qr npm start
```

Scan the QR in WhatsApp → Linked devices.

## Render

This zip includes `render.yaml` and `Procfile`.

Use these environment variables:

```env
NODE_VERSION=20
LOGIN_METHOD=pair
PAIRING_NUMBER=254105197055
OWNER_NUMBER=254105197055
PAIRING_WEB_ENABLED=true
# Optional, recommended when exposing /code publicly:
PAIRING_AUTH_TOKEN=your-secret-token
BOT_NAME=Malai-XD-2.0
OWNER_NUMBER=254105197055
PREFIX=.
CONNECT_NOTIFY=true
MADE_BY=Kimani Samuel
TIME_ZONE=Africa/Nairobi
GREET_DELAY_MS=1200000
AUTOBIO_INTERVAL_MS=600000
```

For persistent sessions on Render, attach a disk and point `SESSION_DIR` to that disk path. Without persistent storage, you may need to relink after redeploys.

## Railway

This zip includes `railway.json`.

Set the same environment variables as Render. Railway can run the project with:

```bash
npm start
```

## Docker

```bash
docker build -t asia-mega-whatsapp-bot .
docker run -p 3000:3000 --env-file .env asia-mega-whatsapp-bot
```

## Branded menu and autobio

The `.menu` command now sends the bot image first, then a full command menu with command emojis and descriptions. The menu footer includes:

```text
⭐ *Made by Kimani Samuel* ⭐
```

The image is loaded from:

```text
assets/bot_image.jpg
```

Autobio can be controlled by the owner:

```text
.autobio on
.autobio off
.settings autobio on
```

When enabled, the bot updates its WhatsApp bio/status like:

```text
🤖 Malai-XD-2.0 is active ⏰ 12:34:56 📅 Fri, 15 May 2026 🚀
```


## Malai-XD-2.0 owner/settings features

Owner contact is now set to `254105197055`. The `.owner` command sends a WhatsApp contact card for the owner.

Settings live in `src/settings.js`. Use these commands in WhatsApp:

```text
.settings
.settings greet on
.greet on
.commandreact on
.autostatus on
.autobio on
.setprefix+
+menu
```

Important toggles:

- `greet`: private-chat only. When enabled, the bot waits about 20 minutes after a private incoming message. If the owner/bot replies in that chat before the timer ends, the greet is cancelled.
- `commandreact`: reacts to commands. Example: `.kick` reacts with 🦵 before removing the user.
- `autostatus`: reacts to every WhatsApp status with rotating emojis, including 🇰🇪.
- `autobio`: updates the WhatsApp bio/status with bot emoji, bot name, active time, date, calendar emoji, and rocket emoji. Default refresh is every 10 minutes; change `AUTOBIO_INTERVAL_MS` in `.env`.

The connected notice is enabled by default. When WhatsApp opens successfully, the bot sends a private message to the owner/self saying `Malai-XD-2.0 connected successfully`. Set `CONNECT_NOTIFY=false` to disable it.

## Prefix and group management

The owner can change the prefix with or without a space:

```text
.setprefix +
.setprefix+
+menu
```

Group admins can manage members with numbers, mentions, or replies:

```text
+add +254101223737 +254700000000
+kick @user
+promote +254101223737
+demote @admin
+approve
+approve +254101223737
+groupinfo
```

Owner-only WhatsApp blocking:

```text
+block +254101223737
+unblock +254101223737
```

## Play/video downloads

The `.play`, `.song`, `.music`, and `.ytmp3` commands download YouTube audio. The `.video` and `.ytmp4` commands download YouTube video. You can also use `.play video <query or URL>`.

Examples:

```text
.play diamond platnumz
.play video diamond platnumz
.video https://youtube.com/watch?v=...
```

The downloader uses `yt-search` plus multiple public downloader API fallbacks. If all public APIs are down, the command will return a clear failure instead of crashing the bot.

## Useful commands

Inside WhatsApp, use your configured prefix:

```text
.menu
.allmenu
.commandcount
.ping
.alive
.groupinfo
.tagall
.github torvalds
.weather London
.calc 12 * (4 + 3)
.bold hello
.neon hello
.ai explain bots
```

See `COMMANDS.md` for the full list.

## Verification

After installing dependencies:

```bash
npm run verify
node scripts/smoke.js
```

Expected output includes:

```text
OK: 420 primary commands, 494 triggers including aliases.
OK: Baileys ESM import compatible.
```

## Notes

YouTube audio/video commands now try real downloads through public API fallbacks. Other downloader/media commands are still safe hooks unless you connect your preferred APIs or ffmpeg pipeline in `src/commands.js`. The core bot, menus, owner controls, group commands, utility commands, text commands, fun commands, and command registry are functional.

## Pairing fixes in this build

- `src/pairing.js` contains the reusable Knightbot-MD style pairing helpers.
- `src/index.js` now starts a health server and pairing server together.
- `/code?number=...` and `/pair?number=...` generate a code only while the bot has no registered session.
- Linux hosts use the Knightbot-MD browser tuple `Ubuntu,Chrome,20.0.04`; Windows, macOS, and Android get matching defaults. You can override with `BROWSER=Platform,Browser,Version`.
- The owner-only `.pair <number>` command now gives correct instructions and can call an external `PAIRING_API_URL` if you provide one.

If pairing fails after a bad deploy, stop the app, delete the `session` folder or attached session disk contents, then restart with the correct number.
