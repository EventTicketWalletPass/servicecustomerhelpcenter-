require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const https = require('https');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 60000,        // Heartbeat every 60 seconds
  pingTimeout: 7200000,       // Wait up to 2 hours before dropping — covers phone background/sleep
  connectTimeout: 45000,
  upgradeTimeout: 30000,
  maxHttpBufferSize: 5e6      // 5MB for image transfers
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'customer.html'));
});

app.get('/customer.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'customer.html'));
});

const activeCustomers = new Map();
const blockedUsers = new Set();
const CHATS_FILE = './chats.json';

// chatHistories: Map<userId, { name: string, messages: [] }>
let chatHistories = new Map();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function loadChats() {
  try {
    if (fs.existsSync(CHATS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8'));
      // Support both old format (array of [userId, messages[]]) and new format
      if (Array.isArray(raw)) {
        chatHistories = new Map(raw.map(([userId, value]) => {
          if (Array.isArray(value)) {
            return [userId, { name: 'Unknown', messages: value }];
          }
          return [userId, value];
        }));
      }
    }
  } catch (e) {
    console.error("Error loading chats:", e);
  }
}

function saveChats() {
  try {
    const data = JSON.stringify(Array.from(chatHistories.entries()));
    fs.writeFileSync(CHATS_FILE, data);
  } catch (e) {
    console.error("Error saving chats:", e);
  }
}

loadChats();

function sendTelegramNotification(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('❌ Missing Telegram credentials. Set TELEGRAM_TOKEN and TELEGRAM_CHAT_ID in Secrets.');
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(text)}`;
  https.get(url, (res) => {
    if (res.statusCode === 200) console.log('✅ Telegram notification sent');
    else console.error('Telegram response:', res.statusCode);
  }).on('error', (e) => console.error('Telegram error:', e));
}

function getActiveSessions() {
  return Array.from(activeCustomers.entries()).map(([userId, data]) => ({
    userId,
    name: data.name
  }));
}

function getAllSessions() {
  return Array.from(chatHistories.entries()).map(([userId, data]) => ({
    userId,
    name: data.name || 'Unknown',
    messageCount: data.messages ? data.messages.length : 0,
    isOnline: activeCustomers.has(userId)
  }));
}

const MAX_CUSTOMERS = 4;

io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);

  socket.on('register_customer', ({ userId, name }) => {
    if (!name) return socket.emit('error', 'Name is required');
    const finalUserId = userId || `TICKET-${socket.id.slice(0,8).toUpperCase()}`;
    const isReturning = activeCustomers.has(finalUserId) || chatHistories.has(finalUserId);

    if (blockedUsers.has(finalUserId)) {
      socket.emit('blocked', { message: 'You have been blocked by support.' });
      return;
    }

    // Enforce max 4 active customers (allow returning sessions through)
    if (!isReturning && activeCustomers.size >= MAX_CUSTOMERS) {
      socket.emit('queue_full', { message: 'All support agents are busy. Please try again later.' });
      return;
    }

    activeCustomers.set(finalUserId, { name, socket });
    socket.userId = finalUserId;
    socket.isCustomer = true;
    socket.join(`chat-${finalUserId}`);

    const isNewChat = !chatHistories.has(finalUserId);
    if (isNewChat) {
      chatHistories.set(finalUserId, { name, messages: [] });
    } else {
      chatHistories.get(finalUserId).name = name;
    }

    // Tell the customer their assigned session ID
    socket.emit('registered', { userId: finalUserId });

    if (isNewChat) {
      const welcome = {
        id: Date.now(),
        sender: 'support',
        text: `Hello ${name}! Thank you for contacting Paypal Support, I'll be assisting you today,l understand you're reaching out regarding your transaction. I'll do my best to help resolve this for you as quickly as possible, Could you please provide more details about the issue you're experiencing? A live agent will be with you shortly"`,
        timestamp: new Date().toISOString()
      };
      chatHistories.get(finalUserId).messages.push(welcome);
      io.to(`chat-${finalUserId}`).emit('new_message', { userId: finalUserId, message: welcome });
      sendTelegramNotification(`🟢 New customer connected: ${name}\nTicket: ${finalUserId}`);
      saveChats();
    }

    io.to('admin_room').emit('active_sessions', getActiveSessions());
    io.to('admin_room').emit('all_sessions', getAllSessions());
  });

  socket.on('user_message', ({ message, image }) => {
    if (!socket.isCustomer || !socket.userId) return;
    const userId = socket.userId;
    if (blockedUsers.has(userId)) return;

    const msgObj = {
      id: Date.now(),
      sender: 'customer',
      text: message ? message.trim() : null,
      image: image || null,
      timestamp: new Date().toISOString()
    };

    if (!chatHistories.has(userId)) chatHistories.set(userId, { name: 'Unknown', messages: [] });
    chatHistories.get(userId).messages.push(msgObj);

    io.to(`chat-${userId}`).emit('new_message', { userId, message: msgObj });
    saveChats();

    const customerName = activeCustomers.get(userId)?.name || 'Customer';
    const notifText = image
      ? `📸 New IMAGE from ${customerName}\nTicket: ${userId}`
      : `💬 New message from ${customerName}\nTicket: ${userId}\n\n${message}`;

    sendTelegramNotification(notifText);
  });

  socket.on('customer_typing', () => {
    if (!socket.isCustomer || !socket.userId) return;
    const name = activeCustomers.get(socket.userId)?.name || 'Customer';
    io.to('admin_room').emit('customer_typing', { userId: socket.userId, name });
  });

  socket.on('admin_connect', () => {
    socket.isAdmin = true;
    socket.join('admin_room');
    socket.emit('active_sessions', getActiveSessions());
    socket.emit('all_sessions', getAllSessions());
  });

  socket.on('join_session', (userId) => {
    if (!socket.isAdmin) return;
    socket.currentUserId = userId;
    socket.join(`chat-${userId}`);
    const entry = chatHistories.get(userId);
    const messages = entry ? entry.messages : [];
    socket.emit('chat_history', { userId, messages: [...messages] });
  });

  socket.on('admin_message', ({ userId, message, image }) => {
    if (!socket.isAdmin || !chatHistories.has(userId)) return;
    const msgObj = {
      id: Date.now(),
      sender: 'support',
      text: message ? message.trim() : null,
      image: image || null,
      timestamp: new Date().toISOString()
    };
    chatHistories.get(userId).messages.push(msgObj);
    io.to(`chat-${userId}`).emit('new_message', { userId, message: msgObj });
    saveChats();
  });

  socket.on('admin_typing', ({ userId }) => {
    if (!socket.isAdmin) return;
    io.to(`chat-${userId}`).emit('support_typing');
  });

  socket.on('admin_block_user', (userId) => {
    blockedUsers.add(userId);
    io.to(`chat-${userId}`).emit('blocked', { message: 'You have been blocked by support.' });
    io.to('admin_room').emit('active_sessions', getActiveSessions());
    io.to('admin_room').emit('all_sessions', getAllSessions());
    saveChats();
  });

  socket.on('admin_delete_chat', (userId) => {
    chatHistories.delete(userId);
    blockedUsers.delete(userId);
    io.to(`chat-${userId}`).emit('chat_deleted');
    io.to('admin_room').emit('active_sessions', getActiveSessions());
    io.to('admin_room').emit('all_sessions', getAllSessions());
    saveChats();
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      activeCustomers.delete(socket.userId);
      io.to('admin_room').emit('active_sessions', getActiveSessions());
      io.to('admin_room').emit('all_sessions', getAllSessions());
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Graceful shutdown — releases the port cleanly on restart
function shutdown() {
  console.log('🔴 Shutting down gracefully…');
  io.close();
  server.close(() => {
    console.log('✅ Server closed.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
