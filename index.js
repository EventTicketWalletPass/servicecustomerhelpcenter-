const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Serve HTML files
app.use(express.static(__dirname));

const activeCustomers = new Map();   // userId → { name, socket }
const blockedUsers = new Set();
const CHATS_FILE = './chats.json';

let chatHistories = new Map();

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

io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);

  // Customer registers
  socket.on('register_customer', ({ userId, name }) => {
    if (!name) return socket.emit('error', 'Name is required');
    const finalUserId = userId || `TICKET-${socket.id.slice(0,8).toUpperCase()}`;

    if (blockedUsers.has(finalUserId)) {
      socket.emit('blocked', { message: 'You have been blocked by support.' });
      return;
    }

    activeCustomers.set(finalUserId, { name, socket });
    socket.userId = finalUserId;
    socket.isCustomer = true;
    socket.join(`chat-${finalUserId}`);

    if (!chatHistories.has(finalUserId)) chatHistories.set(finalUserId, []);

    const welcome = {
      id: Date.now(),
      sender: 'support',
      text: `Hello ${name}! Thank you for contacting PayPal Support. I’ll be assisting you today.`,
      timestamp: new Date().toISOString()
    };
    chatHistories.get(finalUserId).push(welcome);
    io.to(`chat-${finalUserId}`).emit('new_message', { userId: finalUserId, message: welcome });

    io.to('admin_room').emit('active_sessions', getActiveSessions());
    saveChats();
  });

  // Customer message
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
  });

  // Admin connects
  socket.on('admin_connect', () => {
    socket.isAdmin = true;
    socket.join('admin_room');
    socket.emit('active_sessions', getActiveSessions());
  });

  // Admin joins session
  socket.on('join_session', (userId) => {
    if (!socket.isAdmin) return;
    socket.currentUserId = userId;
    socket.join(`chat-${userId}`);

    const history = chatHistories.get(userId) || [];
    socket.emit('chat_history', { userId, messages: [...history] });
  });

  // Admin reply
  socket.on('admin_message', ({ userId, message, image }) => {
    if (!socket.isAdmin || !chatHistories.has(userId)) return;

    const msgObj = {
      id: Date.now(),
      sender: 'support',
      text: message ? message.trim() : null,
      image: image || null,
      timestamp: new Date().toISOString()
    };

    chatHistories.get(userId).push(msgObj);
    io.to(`chat-${userId}`).emit('new_message', { userId, message: msgObj });
    saveChats();
  });

  // Admin block user
  socket.on('admin_block_user', (userId) => {
    blockedUsers.add(userId);
    io.to(`chat-${userId}`).emit('blocked', { message: 'You have been blocked by support.' });
    io.to('admin_room').emit('active_sessions', getActiveSessions());
    saveChats();
  });

  // Admin delete chat
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

function getActiveSessions() {
  return Array.from(activeCustomers.entries()).map(([userId, data]) => ({
    userId,
    name: data.name
  }));
}

// Keep-alive (helps reduce sleep delay on free Render)
setInterval(() => {
  console.log('🟢 Keep-alive ping sent');
}, 4 * 60 * 1000);

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
