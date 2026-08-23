/**
 * SPYCOM TACTICAL ENCRYPTED DEAD-DROP SERVERLESS BACKEND
 * Compatible with Cloudflare Workers / Vercel / Edge Functions
 * 
 * Protocol: 100% Zero-Knowledge Store-and-Forward
 * - Stores encrypted ciphertext blobs only (Zero Plaintext Access)
 * - 24-Hour Automatic TTL Vaporization
 */

// In-Memory Storage for Worker edge instances (or KV / Durable Objects)
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
    const validSignals = roomSignals.get(roomId).filter(s => (now - s.createdAt) < (5 * 60 * 1000)); // 5 min TTL for signals
    if (validSignals.length === 0) {
      roomSignals.delete(roomId);
    } else {
      roomSignals.set(roomId, validSignals);
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS Headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (path === '/' || path === '/health') {
      return new Response(JSON.stringify({
        status: 'ONLINE',
        protocol: 'SPYCOM_ENCRYPTED_DEAD_DROP_v2',
        ttl_hours: 24,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Route: /api/drop/:roomId
    const dropMatch = path.match(/^\/api\/drop\/([a-f0-9]+)$/);
    if (dropMatch) {
      const roomId = dropMatch[1];
      cleanExpiredDrops(roomId);

      // POST /api/drop/:roomId -> Deposit an encrypted blob
      if (request.method === 'POST') {
        try {
          const payload = await request.json();
          if (!payload || !payload.encrypted) {
            return new Response(JSON.stringify({ error: 'Invalid encrypted payload' }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
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
          // Deduplicate by ID
          if (!drops.some(d => d.id === dropEntry.id)) {
            drops.push(dropEntry);
            // Cap at 100 recent messages per room to prevent memory exhaustion
            if (drops.length > 100) drops.shift();
          }

          return new Response(JSON.stringify({ success: true, id: dropEntry.id, storedAt: Date.now() }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: 'Malformed JSON payload' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // GET /api/drop/:roomId -> Retrieve waiting dead drops
      if (request.method === 'GET') {
        const since = parseInt(url.searchParams.get('since') || '0', 10);
        const drops = roomDrops.get(roomId) || [];
        const filtered = drops.filter(d => d.createdAt > since);

        return new Response(JSON.stringify({ drops: filtered, serverTime: Date.now() }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // DELETE /api/drop/:roomId -> Purge room completely (Burn Notice)
      if (request.method === 'DELETE') {
        roomDrops.delete(roomId);
        roomSignals.delete(roomId);
        return new Response(JSON.stringify({ success: true, purged: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Route: /api/signal/:roomId
    const signalMatch = path.match(/^\/api\/signal\/([a-f0-9]+)$/);
    if (signalMatch) {
      const roomId = signalMatch[1];
      cleanExpiredDrops(roomId);

      // POST /api/signal/:roomId -> Broadcast burn notice / duress signal
      if (request.method === 'POST') {
        try {
          const payload = await request.json();
          const signalEntry = {
            type: payload.type, // 'burn_notice' | 'duress_signal' | 'peer_ping'
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

          return new Response(JSON.stringify({ success: true, signal: signalEntry.type }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: 'Malformed signal payload' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // GET /api/signal/:roomId -> Retrieve emergency signals
      if (request.method === 'GET') {
        const since = parseInt(url.searchParams.get('since') || '0', 10);
        const signals = roomSignals.get(roomId) || [];
        const filtered = signals.filter(s => s.createdAt > since);

        return new Response(JSON.stringify({ signals: filtered, serverTime: Date.now() }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  },
};
