const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Stateless Tactical Relay Server Online' });
});

io.on('connection', (socket) => {
  console.log(`[+] Client connected: ${socket.id} (IP: ${socket.handshake.address})`);

  // Join encrypted channel room
  socket.on('join_room', (data) => {
    const { roomId, callsign } = data || {};
    if (!roomId) {
      console.warn(`[!] Client ${socket.id} attempted join_room without roomId`);
      return;
    }
    socket.join(roomId);
    const roomSize = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    console.log(`[>] Client ${socket.id} (${callsign || 'ANON'}) joined room: ${roomId} (Total in room: ${roomSize})`);
    socket.to(roomId).emit('peer_joined', { callsign, socketId: socket.id });
  });

  // Relay encrypted message payload to all peers in room
  socket.on('send_message', (payload) => {
    const { roomId, senderCallsign } = payload || {};
    if (!roomId) {
      console.warn(`[!] send_message received without roomId from ${socket.id}`);
      return;
    }
    const roomSize = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    console.log(`[M] Relaying payload from ${senderCallsign || socket.id} in room ${roomId} (Sockets in room: ${roomSize})`);

    // Broadcast payload to all peers in room EXCEPT sender
    socket.to(roomId).emit('receive_message', payload);
  });

  // Relay burn notice / panic wipe signal to room
  socket.on('burn_notice', (payload) => {
    const { roomId } = payload || {};
    if (!roomId) return;
    console.log(`[!] BURN NOTICE emitted in room ${roomId}`);
    socket.to(roomId).emit('burn_notice', payload);
  });

  // Relay duress distress signal to room
  socket.on('duress_signal', (payload) => {
    const { roomId, senderCallsign } = payload || {};
    if (!roomId) return;
    console.log(`[!] DURESS DISTRESS SIGNAL emitted from ${senderCallsign || socket.id} in room ${roomId}`);
    socket.to(roomId).emit('duress_signal', payload);
  });


  socket.on('disconnect', (reason) => {
    console.log(`[-] Client disconnected: ${socket.id} (Reason: ${reason})`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`[TACTICAL RELAY SERVER] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[SECURITY PROTOCOL] 100% Stateless - Zero Persistence`);
  console.log(`=======================================================`);
});
