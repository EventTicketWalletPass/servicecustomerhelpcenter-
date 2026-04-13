# PayPal Support Chat

A real-time customer support chat application built with Node.js, Express, and Socket.io.

## Features
- Real-time chat between customers and support agents
- Telegram notifications when customers connect or send messages
- Admin dashboard: Active Sessions tab + All Chats history tab
- Search bar to find tickets by User ID or name
- Typing indicators (customer sees "PayPal Assistant is typing…", admin sees customer typing)
- Sound notifications on new messages
- Image sharing support
- User blocking and chat deletion

## Architecture
- **index.js** — Express + Socket.io server. Loads credentials from environment variables.
- **admin.html** — Admin dashboard (support agent view)
- **customer.html** — Customer-facing chat UI (styled as PayPal Assistant)
- **chats.json** — Persistent chat history (gitignored)

## Environment Variables / Secrets
Stored securely in Replit Secrets (never in code):
- `TELEGRAM_TOKEN` — Bot token from @BotFather
- `TELEGRAM_CHAT_ID` — Your personal Telegram chat ID (get from @userinfobot)
- `PORT` — Set to 5000 for Replit webview

## Running
```
node index.js
```

## Keep-alive
Admin client sends a lightweight socket ping every 30 seconds to maintain connection on hosted environments (Render, etc.).
