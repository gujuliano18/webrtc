// server.js — VERSÃO FINAL OTIMIZADA PARA MOBILE + ESTABILIDADE + BIG WIN TOAST
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
app.use(express.urlencoded({ extended: true })); // NECESSÁRIO para receber dados do PHP

// Uploads
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } });

// In-memory rooms
let rooms = [];

// Default hall
if (!rooms.find(r => r.id === 'hall')) {
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

function findRoom(id) { return rooms.find(r => r.id === id); }

// HTTP
app.get('/', (req, res) => res.send('Voice Rooms Server — Running'));
app.get('/rooms', (req, res) => res.json(rooms));

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url });
});

app.use('/uploads', express.static(UPLOAD_DIR));

// ENDPOINT BIG WIN — SUPER TOLERANTE (funciona mesmo se o PHP mandar errado)
app.all('/bigwin', (req, res) => {
  console.log('RECEBIDO /bigwin →', req.method, req.body, req.query);

  let user_id = req.body.user_id || req.query.user_id;
  let username = req.body.username || req.query.username || 'Jogador';
  let amount = req.body.amount || req.query.amount;

  if (!user_id || !amount) {
    console.log('DADOS INCOMPLETOS no /bigwin:', req.body, req.query);
    return res.status(400).send('Faltam dados');
  }

  user_id = parseInt(user_id);
  amount = parseFloat(amount).toFixed(2);

  const message = `${username} ganhou ${amount} créditos!`;

  console.log(`BROADCAST BIG WIN → ${message} (excluindo user ${user_id})`);

  io.sockets.sockets.forEach((socket) => {
    const sid = socket.data?.userId || socketIdToUserId.get(socket.id);
    if (sid && sid !== user_id) {
      socket.emit('big-win-toast', { message });
    }
  });

  res.send('OK');
});
// ======================================================================

// Socket.IO Server com configurações anti-desconexão mobile
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000,
  maxHttpBufferSize: 1e8,
  transports: ['websocket'],
  allowEIO3: true
});

// Mapeamento userId ↔ socketId
const userIdToSocket = new Map();
const socketIdToUserId = new Map();

// Função para emitir room-updated (centralizada)
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

io.on('connection', socket => {
  console.log('Nova conexão:', socket.id);

  socket.on('keep-alive', () => {
    socket.emit('pong');
  });

  socket.on('request-room-update', ({ roomId }) => {
    const room = findRoom(roomId);
    if (room) {
      broadcastRoomUpdate(room);
    }
  });

  // Join room
  socket.on('join-room', ({ roomId, user }, ack) => {
    try {
      const room = findRoom(roomId);
      if (!room) {
        ack?.({ ok: false, reason: 'room-not-found' });
        return socket.emit('join-failed', { reason: 'room-not-found' });
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

      socket.emit('room-clients', room.members.filter(id => id !== user.id));
      socket.to(roomId).emit('user-joined', user.id);
      broadcastRoomUpdate(room);

      console.log(`User ${user.id} entrou na sala ${roomId}`);
      ack?.({ ok: true });
    } catch (e) {
      console.error('join-room error:', e);
      ack?.({ ok: false, reason: 'server_error' });
    }
  });

  // Leave room
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
    console.log(`User ${userId} saiu da sala ${roomId}`);
  });

  // Claim mic
  socket.on('claim-mic', ({ roomId, slotIndex, user }) => {
    const room = findRoom(roomId);
    if (!room) return;

    room.micSlots = room.micSlots || {};
    if (room.micSlots[slotIndex]) {
      return socket.emit('claim-failed', { slotIndex, reason: 'occupied' });
    }

    room.micSlots[slotIndex] = { id: user.id, name: user.name };
    broadcastRoomUpdate(room);
    console.log(`User ${user.id} pegou mic slot ${slotIndex}`);
  });

  // Release mic
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

    if (changed) {
      broadcastRoomUpdate(room);
    }
  });

  // Chat
  socket.on('send-chat', ({ roomId, from, text }) => {
    const room = findRoom(roomId);
    if (!room) return;

    const msg = {
      fromId: from.id,
      fromName: from.name,
      text: text.trim(),
      at: Date.now()
    };

    room.chat = room.chat || [];
    room.chat.push(msg);
    if (room.chat.length > 500) room.chat = room.chat.slice(-500);

    io.to(roomId).emit('chat-message', msg);
  });

  // WebRTC Signaling
  const forwardToUser = (targetUserId, event, data) => {
    const targetSocketId = userIdToSocket.get(targetUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit(event, data);
      return true;
    }
    return false;
  };

  socket.on('webrtc-offer', ({ to, from, offer }) => {
    forwardToUser(to, 'webrtc-offer', { from, offer });
  });

  socket.on('webrtc-answer', ({ to, from, answer }) => {
    forwardToUser(to, 'webrtc-answer', { from, answer });
  });

  socket.on('webrtc-ice', ({ to, from, candidate }) => {
    forwardToUser(to, 'webrtc-ice', { from, candidate });
  });

  // Disconnect: limpeza completa
  socket.on('disconnect', (reason) => {
    const userId = socket.data.userId || socketIdToUserId.get(socket.id);
    console.log(`Disconnect ${socket.id} | User ${userId || 'desconhecido'} | Motivo: ${reason}`);

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
  });
});

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor de voz + notificações rodando na porta ${PORT}`);
  console.log(`Keep-alive ativo | Mobile otimizado | Big Win Toast integrado`);
});


