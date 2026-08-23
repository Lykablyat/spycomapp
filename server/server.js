const express = require('express');
const http = require('http');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// In-Memory Storage for 24-Hour Dead Drops
const roomDrops = new Map(); // roomId -> Array<{ id, senderCallsign, encrypted, createdAt, viewOnce }>
const roomSignals = new Map(); // roomId -> Array<{ type, senderCallsign, createdAt }>

const TTL_MS = 24 * 60 * 60 * 1000; // 24 Hours

function cleanExpiredDrops(roomId) {
  const now = Date.now();
  if (roomDrops.has(roomId)) {
    const validDrops = roomDrops.get(roomId).filter(d => (now - d.createdAt) < TTL_MS);
    if (validDrops.length === 0) {
      roomDrops.delete(roomId);
    } else {
      roomDrops.set(roomId, validDrops);
    }
  }
  if (roomSignals.has(roomId)) {
    const validSignals = roomSignals.get(roomId).filter(s => (now - s.createdAt) < (5 * 60 * 1000));
    if (validSignals.length === 0) {
      roomSignals.delete(roomId);
    } else {
      roomSignals.set(roomId, validSignals);
    }
  }
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ONLINE',
    protocol: 'SPYCOM_ENCRYPTED_DEAD_DROP_v2',
    ttl_hours: 24,
    active_rooms: roomDrops.size,
  });
});

// POST /api/drop/:roomId -> Deposit an encrypted blob
app.post('/api/drop/:roomId', (req, res) => {
  const { roomId } = req.params;
  const payload = req.body;
  cleanExpiredDrops(roomId);

  if (!payload || !payload.encrypted) {
    return res.status(400).json({ error: 'Invalid encrypted payload' });
  }

  const dropEntry = {
    id: payload.id || String(Date.now()),
    senderCallsign: payload.senderCallsign || 'ANON',
    encrypted: payload.encrypted,
    createdAt: payload.createdAt || Date.now(),
    viewOnce: Boolean(payload.viewOnce),
  };

  if (!roomDrops.has(roomId)) {
    roomDrops.set(roomId, []);
  }

  const drops = roomDrops.get(roomId);
  if (!drops.some(d => d.id === dropEntry.id)) {
    drops.push(dropEntry);
    if (drops.length > 100) drops.shift();
  }

  console.log(`[DEAD-DROP] Stored blob ${dropEntry.id} in room ${roomId.substring(0, 10)}... from ${dropEntry.senderCallsign}`);
  res.json({ success: true, id: dropEntry.id, storedAt: Date.now() });
});

// GET /api/drop/:roomId -> Retrieve waiting dead drops
app.get('/api/drop/:roomId', (req, res) => {
  const { roomId } = req.params;
  cleanExpiredDrops(roomId);

  const since = parseInt(req.query.since || '0', 10);
  const drops = roomDrops.get(roomId) || [];
  const filtered = drops.filter(d => d.createdAt > since);

  res.json({ drops: filtered, serverTime: Date.now() });
});

// DELETE /api/drop/:roomId -> Purge room completely (Burn Notice)
app.delete('/api/drop/:roomId', (req, res) => {
  const { roomId } = req.params;
  roomDrops.delete(roomId);
  roomSignals.delete(roomId);
  console.log(`[DEAD-DROP] Room ${roomId.substring(0, 10)}... PURGED by burn notice`);
  res.json({ success: true, purged: true });
});

// POST /api/signal/:roomId -> Broadcast burn notice / duress signal
app.post('/api/signal/:roomId', (req, res) => {
  const { roomId } = req.params;
  const payload = req.body;
  cleanExpiredDrops(roomId);

  const signalEntry = {
    type: payload.type,
    senderCallsign: payload.senderCallsign || 'ANON',
    createdAt: Date.now(),
  };

  if (payload.type === 'burn_notice') {
    roomDrops.delete(roomId);
  }

  if (!roomSignals.has(roomId)) {
    roomSignals.set(roomId, []);
  }
  roomSignals.get(roomId).push(signalEntry);

  console.log(`[DEAD-DROP] Signal '${signalEntry.type}' recorded in room ${roomId.substring(0, 10)}...`);
  res.json({ success: true, signal: signalEntry.type });
});

// GET /api/signal/:roomId -> Retrieve emergency signals
app.get('/api/signal/:roomId', (req, res) => {
  const { roomId } = req.params;
  cleanExpiredDrops(roomId);

  const since = parseInt(req.query.since || '0', 10);
  const signals = roomSignals.get(roomId) || [];
  const filtered = signals.filter(s => s.createdAt > since);

  res.json({ signals: filtered, serverTime: Date.now() });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`[TACTICAL DEAD-DROP RELAY] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[SECURITY PROTOCOL] 100% Zero-Knowledge Store-and-Forward (24h TTL)`);
  console.log(`=======================================================`);
});
