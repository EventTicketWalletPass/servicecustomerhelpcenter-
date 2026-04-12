const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Serve HTML files
app.use(express.static(__dirname));

const activeCustomers = new Map();   // userId → { name, socket }
const chatHistories = new Map();     // userId → array of messages

io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);

  // Customer registers
  socket.on('register_customer', ({ userId, name }) => {
    if (!name) return socket.emit('error', 'Name is required');
    const finalUserId = userId || `TICKET-${socket.id.slice(0,8).toUpperCase()}`;

    activeCustomers.set(finalUserId, { name, socket });
    socket.userId = finalUserId;
    socket.isCustomer = true;
    socket.join(`chat-${finalUserId}`);

    if (!chatHistories.has(finalUserId)) chatHistories.set(finalUserId, []);

    const welcome = {
      id: Date.now(),
      sender: 'support',
      text: `Hello ${name}! Thank you for contacting Paypal Support, I’ll be assisting you today,I understand you’re reaching out regarding your transaction. I’ll do my best to help resolve this for you as quickly as possible,Could you please provide more details about the issue you're experiencing?`,
      timestamp: new Date().toISOString()
    };
    chatHistories.get(finalUserId).push(welcome);
    io.to(`chat-${finalUserId}`).emit('new_message', { userId: finalUserId, message: welcome });

    io.to('admin_room').emit('active_sessions', getActiveSessions());
  });

  // ✅ CUSTOMER SENDS TEXT OR IMAGE
  socket.on('user_message', ({ message, image }) => {
    if (!socket.isCustomer || !socket.userId) return;

    const userId = socket.userId;
    const msgObj = {
      id: Date.now(),
      sender: 'customer',           // ← This is the important key
      text: message ? message.trim() : null,
      image: image || null,         // ← base64 image
      timestamp: new Date().toISOString()
    };

    if (!chatHistories.has(userId)) chatHistories.set(userId, []);
    chatHistories.get(userId).push(msgObj);

    // Broadcast to everyone in this chat (customer + admin)
    io.to(`chat-${userId}`).emit('new_message', { userId, message: msgObj });
  });

  // Admin connects
  socket.on('admin_connect', () => {
    socket.isAdmin = true;
    socket.join('admin_room');
    socket.emit('active_sessions', getActiveSessions());
  });

  // Admin joins a session
  socket.on('join_session', (userId) => {
    if (!socket.isAdmin || !activeCustomers.has(userId)) {
      return socket.emit('error', 'Session not found');
    }
    socket.currentUserId = userId;
    socket.join(`chat-${userId}`);

    const history = chatHistories.get(userId) || [];
    socket.emit('chat_history', { userId, messages: [...history] });
  });

  // Admin replies (text only for now)
  socket.on('admin_message', ({ userId, message }) => {
    if (!socket.isAdmin || !chatHistories.has(userId)) return;
    const msgObj = {
      id: Date.now(),
      sender: 'support',
      text: message ? message.trim() : null,
      image: null,
      timestamp: new Date().toISOString()
    };
    chatHistories.get(userId).push(msgObj);
    io.to(`chat-${userId}`).emit('new_message', { userId, message: msgObj });
  });

  socket.on('disconnect', () => {
    if (socket.isCustomer && socket.userId) {
      activeCustomers.delete(socket.userId);
      io.to('admin_room').emit('active_sessions', getActiveSessions());
    }
  });
});

function getActiveSessions() {
  return Array.from(activeCustomers.entries()).map(([userId, data]) => ({
    userId,
    name: data.name
  }));
}

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running with FULL IMAGE SUPPORT on http://localhost:${PORT}`);
});