// server.js - Socket.IO signaling server (Node.js)
// Deploy em Replit, Railway, Render, etc.
// Não armazena estado permanente; apenas encaminha mensagens de sinalização.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Configura CORS para aceitar chamadas do seu domínio (ou use '*')
const io = new Server(server, {
  cors: { origin: "*" }
});

// rota simples
app.get('/', (req, res) => res.send('Signaling server running'));

io.on('connection', (socket) => {
  // entrar em sala
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    // notifica os outros
    socket.to(roomId).emit('user-joined', socket.id);
    // envia lista atual de participantes para quem entrou (opcional)
    const clients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
    socket.emit('room-clients', clients.filter(id => id !== socket.id));
  });

  socket.on('offer', (data) => {
    // data: { to, from, offer }
    socket.to(data.to).emit('offer', { from: data.from, offer: data.offer });
  });

  socket.on('answer', (data) => {
    // data: { to, from, answer }
    socket.to(data.to).emit('answer', { from: data.from, answer: data.answer });
  });

  socket.on('ice-candidate', (data) => {
    // data: { to, from, candidate }
    socket.to(data.to).emit('ice-candidate', { from: data.from, candidate: data.candidate });
  });

  socket.on('leave-room', (roomId) => {
    socket.leave(roomId);
    socket.to(roomId).emit('user-left', socket.id);
  });

  socket.on('disconnecting', () => {
    const rooms = Array.from(socket.rooms).filter(r => r !== socket.id);
    rooms.forEach(room => socket.to(room).emit('user-left', socket.id));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Signaling server running on port ${PORT}`));
