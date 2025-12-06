// server.js
// Simple Socket.IO + Express server for Voice Rooms prototype
// - In-memory rooms storage (replace with DB in production)
// - Upload endpoint for avatars/covers (multipart/form-data)
// - Socket events: get-rooms, create-room, join-room, leave-room, claim-mic, release-mic, send-chat

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
app.use(express.json({ limit: '5mb' }));

// Serve uploaded files
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB max

// In-memory data
// room: { id, name, cover, ownerId, ownerName, ownerOnline, memberCount, members:[], micSlots:{ index: {id,name} }, chat:[] , createdAt }
let rooms = [];

// Simple helper
function findRoom(id) { return rooms.find(r => r.id === id); }

// HTTP endpoints
app.get('/', (req, res) => res.send('Signaling + Rooms server running'));
app.get('/rooms', (req, res) => res.json(rooms));

// Upload endpoint: returns public URL for uploaded file
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url });
});

// Make uploaded files available
app.use('/uploads', express.static(UPLOAD_DIR));

// Create HTTP server + socket.io
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // tighten origin in production
});

// Socket.IO event handlers
io.on('connection', socket => {
  console.log('socket connected', socket.id);

  // When client requests current rooms
  socket.on('get-rooms', () => {
    socket.emit('rooms-list', rooms);
  });

  // Create room (expects full room object from client)
  socket.on('create-room', (room) => {
    if (!room || !room.id) return;
    // ensure room id unique
    if (findRoom(room.id)) {
      socket.emit('create-failed', { reason: 'id-exists' });
      return;
    }
    // normalize fields
    room.memberCount = room.memberCount || 0;
    room.members = room.members || [];
    room.micSlots = room.micSlots || {};
    room.chat = room.chat || [];
    room.createdAt = room.createdAt || Date.now();
    rooms.unshift(room);
    // broadcast to all
    io.emit('room-created', room);
    console.log('room-created', room.id);
  });

  // Join room
  socket.on('join-room', (data) => {
    try {
      const { roomId, user } = data || {};
      const room = findRoom(roomId);
      if (!room) return;
      socket.join(roomId);
      if (!room.members.includes(user.id)) room.members.push(user.id);
      room.memberCount = room.members.length;
      // optionally mark owner online if user is owner
      if (room.ownerId === user.id) room.ownerOnline = true;
      io.to(roomId).emit('room-updated', room);
      io.emit('room-updated', room); // update listing too
      console.log(`user ${user.id} joined ${roomId}`);
    } catch (e) { console.error('join-room err', e); }
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
    } catch (e) { console.error('leave-room err', e); }
  });

  // Claim mic slot
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
    } catch (e) { console.error('claim-mic err', e); }
  });

  // Release mic slot
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
    } catch (e) { console.error('release-mic err', e); }
  });

  // Chat messages
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
    } catch (e) { console.error('send-chat err', e); }
  });

  // OPTIONAL: handle WebRTC offer/answer/ice passthrough if you want server to relay
  socket.on('webrtc-offer', (data) => {
    const { to, from, offer } = data || {};
    if (to) socket.to(to).emit('webrtc-offer', { from, offer });
  });
  socket.on('webrtc-answer', (data) => {
    const { to, from, answer } = data || {};
    if (to) socket.to(to).emit('webrtc-answer', { from, answer });
  });
  socket.on('webrtc-ice', (data) => {
    const { to, from, candidate } = data || {};
    if (to) socket.to(to).emit('webrtc-ice', { from, candidate });
  });

  // Disconnect: remove user from any rooms and free mic slots
  socket.on('disconnecting', () => {
    // Note: socket.rooms contains rooms this socket is in (including its own id)
    try {
      // We don't have a mapping socketId -> userId by default, so clients should send leave-room on unload.
      // Optionally implement heartbeat/online API to mark owner online/offline.
      console.log('socket disconnecting', socket.id);
    } catch (e) { console.error(e); }
  });

  socket.on('disconnect', (reason) => {
    console.log('socket disconnected', socket.id, reason);
    // If you maintain mapping socket->user, remove user from rooms here
  });

});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Signaling server running on port', PORT);
});

