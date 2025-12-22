// =====================================================
// server.js — VOICE + REALTIME STATS (FINAL ESTÁVEL)
// =====================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

// =====================================================
// APP BASE
// =====================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));

// =====================================================
// UPLOADS
// =====================================================
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) =>
    cb(null, uuidv4() + path.extname(file.originalname))
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }
});

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url });
});

app.use('/uploads', express.static(UPLOAD_DIR));

// =====================================================
// ROOMS (VOICE)
// =====================================================
let rooms = [];

function findRoom(id) {
  return rooms.find(r => r.id === id);
}

// Sala padrão
if (!findRoom('hall')) {
  rooms.unshift({
    id: 'hall',
    name: 'Hall',
    cover: null,
    ownerId: null,
    ownerName: null,
    ownerOnline: false,
    memberCount: 0,
    members: [],
    micSlots: {},
    chat: [],
    createdAt: Date.now()
  });
  console.log('Sala padrão "hall" criada');
}

app.get('/', (_, res) => res.send('Voice + Stats Server — Running'));
app.get('/rooms', (_, res) => res.json(rooms));

// =====================================================
// SOCKET.IO SERVER
// =====================================================
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket'],
  pingInterval: 10000,
  pingTimeout: 5000,
  maxHttpBufferSize: 1e8,
  allowEIO3: true
});

// =====================================================
// MAPS
// =====================================================
const userIdToSocket = new Map();
const socketIdToUserId = new Map();

// =====================================================
// REALTIME STATS (GLOBAL STATE)
// =====================================================
const statsUsers = new Map(); // socket.id → user stats

// =====================================================
// HELPERS
// =====================================================
function broadcastRoomUpdate(room) {
  const cleanRoom = {
    ...room,
    members: [...room.members],
    micSlots: { ...room.micSlots },
    chat: room.chat.slice(-100)
  };

  io.to(room.id).emit('room-updated', cleanRoom);
  io.emit('room-updated', cleanRoom);
}

// =====================================================
// SOCKET EVENTS
// =====================================================
io.on('connection', socket => {
  console.log('Nova conexão:', socket.id);

  // =====================================================
  // KEEP ALIVE (MOBILE)
  // =====================================================
  socket.on('keep-alive', () => socket.emit('pong'));

  // =====================================================
  // STATS — JOIN
  // =====================================================
  socket.on('stats:join', data => {
    statsUsers.set(socket.id, {
      socket_id: socket.id,
      user_id: data.user_id,
      username: data.username || '',
      page: data.page || '',
      ip: data.ip || socket.handshake.address,
      city: data.city || '',
      country: data.country || '',
      ua: data.ua || '',
      connected_at: Date.now(),
      last_seen: Date.now(),
      hidden: false
    });

    io.emit('stats:broadcast', Array.from(statsUsers.values()));
  });

  // =====================================================
  // STATS — UPDATE (CRÍTICO)
  // =====================================================
  socket.on('stats:update', data => {
    const u = statsUsers.get(socket.id);
    if (!u) return;

    u.page = data.page ?? u.page;
    u.last_seen = Date.now();

    io.emit('stats:broadcast', Array.from(statsUsers.values()));
  });

  socket.on('stats:visibility', data => {
    const u = statsUsers.get(socket.id);
    if (!u) return;

    u.hidden = !!data.hidden;
    io.emit('stats:broadcast', Array.from(statsUsers.values()));
  });

  socket.on('stats:leave', () => {
    statsUsers.delete(socket.id);
    io.emit('stats:broadcast', Array.from(statsUsers.values()));
  });

  // =====================================================
  // VOICE — JOIN ROOM
  // =====================================================
  socket.on('join-room', ({ roomId, user }, ack) => {
    try {
      const room = findRoom(roomId);
      if (!room) {
        ack?.({ ok: false, reason: 'room-not-found' });
        return;
      }

      if (user?.id) {
        userIdToSocket.set(user.id, socket.id);
        socketIdToUserId.set(socket.id, user.id);
        socket.data.userId = user.id;
        socket.data.user = user;
      }

      socket.join(roomId);

      if (!room.members.includes(user.id)) {
        room.members.push(user.id);
      }

      room.memberCount = room.members.length;

      socket.emit(
        'room-clients',
        room.members.filter(id => id !== user.id)
      );

      socket.to(roomId).emit('user-joined', user.id);

      broadcastRoomUpdate(room);
      ack?.({ ok: true });
    } catch (e) {
      console.error('join-room error:', e);
      ack?.({ ok: false });
    }
  });

  socket.on('leave-room', ({ roomId, userId }) => {
    const room = findRoom(roomId);
    if (!room) return;

    socket.leave(roomId);
    room.members = room.members.filter(id => id !== userId);

    Object.keys(room.micSlots).forEach(slot => {
      if (room.micSlots[slot]?.id === userId) {
        delete room.micSlots[slot];
      }
    });

    room.memberCount = room.members.length;
    broadcastRoomUpdate(room);
  });

  socket.on('claim-mic', ({ roomId, slotIndex, user }) => {
    const room = findRoom(roomId);
    if (!room) return;

    if (room.micSlots[slotIndex]) {
      return socket.emit('claim-failed', { slotIndex });
    }

    room.micSlots[slotIndex] = { id: user.id, name: user.name };
    broadcastRoomUpdate(room);
  });

  socket.on('release-mic', ({ roomId, userId }) => {
    const room = findRoom(roomId);
    if (!room) return;

    let changed = false;
    Object.keys(room.micSlots).forEach(slot => {
      if (room.micSlots[slot]?.id === userId) {
        delete room.micSlots[slot];
        changed = true;
      }
    });

    if (changed) broadcastRoomUpdate(room);
  });

  socket.on('send-chat', ({ roomId, from, text }) => {
    const room = findRoom(roomId);
    if (!room) return;

    const msg = {
      fromId: from.id,
      fromName: from.name,
      text: text.trim(),
      at: Date.now()
    };

    room.chat.push(msg);
    if (room.chat.length > 500) room.chat = room.chat.slice(-500);
    io.to(roomId).emit('chat-message', msg);
  });

  // =====================================================
  // WEBRTC SIGNALING
  // =====================================================
  const forwardToUser = (targetUserId, event, data) => {
    const targetSocketId = userIdToSocket.get(targetUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit(event, data);
    }
  };

  socket.on('webrtc-offer', d =>
    forwardToUser(d.to, 'webrtc-offer', d)
  );
  socket.on('webrtc-answer', d =>
    forwardToUser(d.to, 'webrtc-answer', d)
  );
  socket.on('webrtc-ice', d =>
    forwardToUser(d.to, 'webrtc-ice', d)
  );

  // =====================================================
  // DISCONNECT
  // =====================================================
  socket.on('disconnect', reason => {
    statsUsers.delete(socket.id);
    io.emit('stats:broadcast', Array.from(statsUsers.values()));

    const userId =
      socket.data.userId || socketIdToUserId.get(socket.id);

    if (userId) {
      userIdToSocket.delete(userId);
      socketIdToUserId.delete(socket.id);

      rooms.forEach(room => {
        let changed = false;

        if (room.members.includes(userId)) {
          room.members = room.members.filter(id => id !== userId);
          changed = true;
        }

        Object.keys(room.micSlots).forEach(slot => {
          if (room.micSlots[slot]?.id === userId) {
            delete room.micSlots[slot];
            changed = true;
          }
        });

        if (changed) {
          room.memberCount = room.members.length;
          broadcastRoomUpdate(room);
        }
      });
    }

    console.log(
      `Disconnect ${socket.id} | User ${userId || 'desconhecido'} | ${reason}`
    );
  });
});

// =====================================================
// START
// =====================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Voice + Stats ativos | Estado global OK`);
});
