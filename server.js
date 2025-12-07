// server.js
// Signaling + Rooms server with userId <-> socketId mapping
// - Save as server.js
// - Requires: express, socket.io, multer, cors, uuid

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));

// Uploads directory
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } });

// In-memory rooms storage
// room: { id, name, cover, ownerId, ownerName, ownerOnline, memberCount, members:[], micSlots:{}, chat:[], createdAt }
let rooms = [];

// Helper
function findRoom(id) { return rooms.find(r => r.id === id); }

// HTTP endpoints
app.get('/', (req, res) => res.send('Signaling + Rooms server running'));
app.get('/rooms', (req, res) => res.json(rooms));

// Upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url });
});
app.use('/uploads', express.static(UPLOAD_DIR));

// Create HTTP server + Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // tighten in production
});

// Maps to forward signaling by userId
const userIdToSocket = new Map(); // userId -> socketId
const socketIdToUserId = new Map(); // socketId -> userId

// Socket.IO handlers
io.on('connection', socket => {
  console.log('socket connected', socket.id);

  // Client asks list of rooms
  socket.on('get-rooms', () => {
    socket.emit('rooms-list', rooms);
  });

  // Create room
  socket.on('create-room', (room) => {
    try {
      if (!room || !room.id) return socket.emit('create-failed', { reason: 'invalid_room' });
      if (findRoom(room.id)) {
        socket.emit('create-failed', { reason: 'id-exists' });
        return;
      }
      room.memberCount = room.memberCount || 0;
      room.members = room.members || [];
      room.micSlots = room.micSlots || {};
      room.chat = room.chat || [];
      room.createdAt = room.createdAt || Date.now();
      rooms.unshift(room);
      io.emit('room-created', room);
      console.log('room-created', room.id);
    } catch (e) {
      console.error('create-room err', e);
      socket.emit('create-failed', { reason: 'server_error' });
    }
  });

  // Join room - register mapping userId <-> socket.id, reply room-clients (userIds) to joiner
  socket.on('join-room', (data) => {
    try {
      const { roomId, user } = data || {};
      const room = findRoom(roomId);
      if (!room) {
        socket.emit('join-failed', { reason: 'room-not-found' });
        return;
      }

      // Register mapping
      if (user && user.id) {
        userIdToSocket.set(user.id, socket.id);
        socketIdToUserId.set(socket.id, user.id);
        socket.data.userId = user.id;
      }

      // Send who is already in the room (userIds)
      const currentClients = (room.members || []).slice();
      socket.emit('room-clients', currentClients);

      // Join socket.io room
      socket.join(roomId);
      if (!room.members.includes(user.id)) room.members.push(user.id);
      room.memberCount = room.members.length;
      if (room.ownerId === user.id) room.ownerOnline = true;

      // Notify other clients (in room) a user-joined (userId)
      socket.to(roomId).emit('user-joined', user.id);

      // Broadcast updated room state
      io.to(roomId).emit('room-updated', room);
      io.emit('room-updated', room);
      console.log(`user ${user.id} joined ${roomId} (socket ${socket.id})`);
    } catch (e) {
      console.error('join-room err', e);
      socket.emit('join-failed', { reason: 'server_error' });
    }
  });

  // Leave room
  socket.on('leave-room', (data) => {
    try {
      const { roomId, userId } = data || {};
      const room = findRoom(roomId);
      if (!room) return;
      socket.leave(roomId);
      room.members = (room.members || []).filter(id => id !== userId);
      // release mic slots occupied by this user
      if (room.micSlots) {
        Object.keys(room.micSlots).forEach(k => {
          if (room.micSlots[k] && room.micSlots[k].id === userId) delete room.micSlots[k];
        });
      }
      room.memberCount = room.members.length;
      io.to(roomId).emit('room-updated', room);
      io.emit('room-updated', room);
      console.log(`user ${userId} left ${roomId}`);
    } catch (e) {
      console.error('leave-room err', e);
    }
  });

  // Claim mic
  socket.on('claim-mic', (data) => {
    try {
      const { roomId, slotIndex, user } = data || {};
      const room = findRoom(roomId);
      if (!room) return;
      room.micSlots = room.micSlots || {};
      if (room.micSlots[slotIndex]) {
        socket.emit('claim-failed', { slotIndex, reason: 'occupied' });
        return;
      }
      room.micSlots[slotIndex] = { id: user.id, name: user.name };
      if (!room.members.includes(user.id)) room.members.push(user.id);
      room.memberCount = room.members.length;
      io.to(roomId).emit('room-updated', room);
      io.emit('room-updated', room);
      console.log(`user ${user.id} claimed slot ${slotIndex} in ${roomId}`);
    } catch (e) {
      console.error('claim-mic err', e);
      socket.emit('claim-failed', { reason: 'server_error' });
    }
  });

  // Release mic
  socket.on('release-mic', (data) => {
    try {
      const { roomId, slotIndex, userId } = data || {};
      const room = findRoom(roomId);
      if (!room) return;
      if (room.micSlots && room.micSlots[slotIndex] && room.micSlots[slotIndex].id === userId) {
        delete room.micSlots[slotIndex];
      }
      io.to(roomId).emit('room-updated', room);
      io.emit('room-updated', room);
      console.log(`user ${userId} released slot ${slotIndex} in ${roomId}`);
    } catch (e) {
      console.error('release-mic err', e);
    }
  });

  // Chat
  socket.on('send-chat', (data) => {
    try {
      const { roomId, from, text } = data || {};
      const room = findRoom(roomId);
      if (!room) return;
      room.chat = room.chat || [];
      const msg = { roomId, fromId: from.id, fromName: from.name, text, at: Date.now() };
      room.chat.push(msg);
      io.to(roomId).emit('chat-message', msg);
      console.log(`chat in ${roomId} from ${from.id}`);
    } catch (e) {
      console.error('send-chat err', e);
    }
  });

  // Helper: forward by userId -> socketId
  function forwardToUser(targetUserId, eventName, payload) {
    const targetSocketId = userIdToSocket.get(targetUserId);
    if (!targetSocketId) {
      console.warn('forwardToUser: no socket for userId', targetUserId);
      return false;
    }
    io.to(targetSocketId).emit(eventName, payload);
    return true;
  }

  // WebRTC relays (expects to/from as userId)
  socket.on('webrtc-offer', (data) => {
    try {
      const { to, from, offer } = data || {};
      if (!to) return;
      const ok = forwardToUser(to, 'webrtc-offer', { from, offer });
      console.log('webrtc-offer received from', from, '-> forward to', to, 'ok?', ok);
    } catch (e) { console.error('webrtc-offer err', e); }
  });

  socket.on('webrtc-answer', (data) => {
    try {
      const { to, from, answer } = data || {};
      if (!to) return;
      const ok = forwardToUser(to, 'webrtc-answer', { from, answer });
      console.log('webrtc-answer received from', from, '-> forward to', to, 'ok?', ok);
    } catch (e) { console.error('webrtc-answer err', e); }
  });

  socket.on('webrtc-ice', (data) => {
    try {
      const { to, from, candidate } = data || {};
      if (!to) return;
      const ok = forwardToUser(to, 'webrtc-ice', { from, candidate });
      // optional: log less verbosely for ICE
      // console.log('webrtc-ice forward', from, '->', to, ok);
    } catch (e) { console.error('webrtc-ice err', e); }
  });

  // Optional: relay direct signaling events if clients use socket ids (not userIds)
  socket.on('signal-to-socket', (data) => {
    const { toSocketId, event, payload } = data || {};
    if (!toSocketId || !event) return;
    io.to(toSocketId).emit(event, payload);
  });

  // Disconnect cleanup
  socket.on('disconnect', (reason) => {
    try {
      const uid = socket.data.userId || socketIdToUserId.get(socket.id);
      console.log('socket disconnected', socket.id, 'userId', uid, 'reason', reason);
      if (uid) {
        userIdToSocket.delete(uid);
        socketIdToUserId.delete(socket.id);
        // remove user from rooms and free mic slots
        rooms.forEach((room) => {
          let changed = false;
          if (room.members && room.members.includes(uid)) {
            room.members = room.members.filter(id => id !== uid);
            changed = true;
          }
          if (room.micSlots) {
            Object.keys(room.micSlots).forEach(k => {
              if (room.micSlots[k] && room.micSlots[k].id === uid) {
                delete room.micSlots[k];
                changed = true;
              }
            });
          }
          if (changed) {
            room.memberCount = (room.members || []).length;
            io.to(room.id).emit('room-updated', room);
            io.emit('room-updated', room);
          }
        });
      }
    } catch (e) {
      console.error('disconnect cleanup err', e);
    }
  });

});

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Signaling server running on port', PORT);
});
