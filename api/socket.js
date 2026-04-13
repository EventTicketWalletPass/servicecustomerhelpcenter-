
const { Server } = require('socket.io');
const fs = require('fs');
const https = require('https');

let io;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CHATS_FILE = './chats.json';
let chatHistories = new Map();
const activeCustomers = new Map();
const blockedUsers = new Set();

function loadChats() {
  try {
    if (fs.existsSync(CHATS_FILE)) {
      const data = fs.readFileSync(CHATS_FILE, 'utf8');
      chatHistories = new Map(JSON.parse(data));
    }
  } catch (e) {}
}

function saveChats() {
  try {
    const data = JSON.stringify(Array.from(chatHistories.entries()));
    fs.writeFileSync(CHATS_FILE, data);
  } catch (e) {}
}

loadChats();

function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(text)}`;
  https.get(url);
}

module.exports = (req, res) => {
  if (!res.socket.server.io) {
    console.log('🚀 Initializing Socket.io on Vercel...');
    io = new Server(res.socket.server, {
      path: '/socket.io',
      cors: { origin: "*" }
    });
    res.socket.server.io = io;

    io.on('connection', (socket) => {
      console.log('🔌 User connected:', socket.id);

      socket.on('register_customer', ({ userId, name }) => {
        const finalUserId = userId || `TICKET-${socket.id.slice(0,8).toUpperCase()}`;
        if (blockedUsers.has(finalUserId)) return socket.emit('blocked', { message: 'You have been blocked.' });

        activeCustomers.set(finalUserId, { name, socket });
        socket.userId = finalUserId;
        socket.isCustomer = true;
        socket.join(`chat-${finalUserId}`);

        if (!chatHistories.has(finalUserId)) chatHistories.set(finalUserId, []);

        const welcome = { id: Date.now(), sender: 'support', text: `Hello ${name}! Thank you for contacting PayPal Support.`, timestamp: new Date().toISOString() };
        chatHistories.get(finalUserId).push(welcome);
        io.to(`chat-${finalUserId}`).emit('new_message', { userId: finalUserId, message: welcome });

        io.to('admin_room').emit('active_sessions', getActiveSessions());
        saveChats();
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

        if (!chatHistories.has(userId)) chatHistories.set(userId, []);
        chatHistories.get(userId).push(msgObj);

        io.to(`chat-${userId}`).emit('new_message', { userId, message: msgObj });
        saveChats();

        const customerName = activeCustomers.get(userId)?.name || 'Customer';
        const notif = image 
          ? `📸 New IMAGE from ${customerName}\nTicket: ${userId}`
          : `💬 New message from ${customerName}\nTicket: ${userId}\n\n${message}`;
        sendTelegram(notif);
      });

      socket.on('admin_connect', () => {
        socket.isAdmin = true;
        socket.join('admin_room');
        socket.emit('active_sessions', getActiveSessions());
      });

      socket.on('join_session', (userId) => {
        if (!socket.isAdmin) return;
        socket.currentUserId = userId;
        socket.join(`chat-${userId}`);
        const history = chatHistories.get(userId) || [];
        socket.emit('chat_history', { userId, messages: [...history] });
      });

      socket.on('admin_message', ({ userId, message, image }) => {
        if (!socket.isAdmin || !chatHistories.has(userId)) return;
        const msgObj = { id: Date.now(), sender: 'support', text: message ? message.trim() : null, image: image || null, timestamp: new Date().toISOString() };
        chatHistories.get(userId).push(msgObj);
        io.to(`chat-${userId}`).emit('new_message', { userId, message: msgObj });
        saveChats();
      });

      socket.on('admin_block_user', (userId) => {
        blockedUsers.add(userId);
        io.to(`chat-${userId}`).emit('blocked', { message: 'You have been blocked by support.' });
        io.to('admin_room').emit('active_sessions', getActiveSessions());
        saveChats();
      });

      socket.on('admin_delete_chat', (userId) => {
        chatHistories.delete(userId);
        blockedUsers.delete(userId);
        io.to(`chat-${userId}`).emit('chat_deleted');
        io.to('admin_room').emit('active_sessions', getActiveSessions());
        saveChats();
      });

      socket.on('disconnect', () => {
        if (socket.userId) activeCustomers.delete(socket.userId);
        io.to('admin_room').emit('active_sessions', getActiveSessions());
      });
    });
  }

  res.end();
};

function getActiveSessions() {
  return Array.from(activeCustomers.entries()).map(([userId, data]) => ({
    userId,
    name: data.name
  }));
}
