/**
 * SPYCOM GLOBAL ENCRYPTED DEAD-DROP // CLOUDFLARE WORKER
 * 
 * Protocol: 100% Zero-Knowledge Store-and-Forward
 * - Edge Persistent (Cloudflare KV with 24-Hour Native TTL)
 * - Distributed across 300+ Global Data Centers
 * - 0ms Cold Start // Always-On // Free Tier Forever
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// In-memory fallback if KV namespace is not bound
const memoryStore = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Health check
    if (path === '/' || path === '/health') {
      return new Response(
        JSON.stringify({
          status: 'ONLINE',
          protocol: 'SPYCOM_DEAD_DROP_CLOUDFLARE_v2',
          storage: env?.SPYCOM_KV ? 'CLOUDFLARE_KV_GLOBAL' : 'EDGE_MEMORY',
          ttl_hours: 24,
          timestamp: Date.now(),
        }),
        { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // Route: /api/drop/:roomId
    const dropMatch = path.match(/^\/api\/drop\/([a-f0-9]+)$/);
    if (dropMatch) {
      const roomId = dropMatch[1];
      const kvKey = `room:${roomId}:drops`;

      // POST /api/drop/:roomId -> Deposit an encrypted blob
      if (request.method === 'POST') {
        try {
          const payload = await request.json();
          if (!payload || !payload.encrypted) {
            return new Response(JSON.stringify({ error: 'Invalid encrypted payload' }), {
              status: 400,
              headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
            });
          }

          const dropEntry = {
            id: payload.id || String(Date.now()),
            senderCallsign: payload.senderCallsign || 'ANON',
            encrypted: payload.encrypted,
            createdAt: payload.createdAt || Date.now(),
            viewOnce: Boolean(payload.viewOnce),
          };

          // Fetch existing drops
          let drops = [];
          if (env?.SPYCOM_KV) {
            const raw = await env.SPYCOM_KV.get(kvKey, { type: 'json' });
            drops = Array.isArray(raw) ? raw : [];
          } else {
            drops = memoryStore.get(kvKey) || [];
          }

          // Deduplicate and append
          if (!drops.some(d => d.id === dropEntry.id)) {
            drops.push(dropEntry);
            if (drops.length > 100) drops.shift(); // Keep last 100 max
          }

          // Save with 24-hour expiration TTL (86400 seconds)
          if (env?.SPYCOM_KV) {
            await env.SPYCOM_KV.put(kvKey, JSON.stringify(drops), { expirationTtl: 86400 });
          } else {
            memoryStore.set(kvKey, drops);
          }

          return new Response(
            JSON.stringify({ success: true, id: dropEntry.id, storedAt: Date.now() }),
            { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        } catch (err) {
          return new Response(JSON.stringify({ error: 'Malformed payload' }), {
            status: 400,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }
      }

      // GET /api/drop/:roomId -> Retrieve waiting dead drops
      if (request.method === 'GET') {
        const since = parseInt(url.searchParams.get('since') || '0', 10);
        let drops = [];

        if (env?.SPYCOM_KV) {
          const raw = await env.SPYCOM_KV.get(kvKey, { type: 'json' });
          drops = Array.isArray(raw) ? raw : [];
        } else {
          drops = memoryStore.get(kvKey) || [];
        }

        const filtered = drops.filter(d => d.createdAt > since);

        return new Response(
          JSON.stringify({ drops: filtered, serverTime: Date.now() }),
          { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      // DELETE /api/drop/:roomId -> Purge room completely (Burn Notice)
      if (request.method === 'DELETE') {
        if (env?.SPYCOM_KV) {
          await env.SPYCOM_KV.delete(kvKey);
          await env.SPYCOM_KV.delete(`room:${roomId}:signals`);
        } else {
          memoryStore.delete(kvKey);
          memoryStore.delete(`room:${roomId}:signals`);
        }

        return new Response(
          JSON.stringify({ success: true, purged: true }),
          { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Route: /api/signal/:roomId (Burn notices / duress signals)
    const signalMatch = path.match(/^\/api\/signal\/([a-f0-9]+)$/);
    if (signalMatch) {
      const roomId = signalMatch[1];
      const kvKey = `room:${roomId}:signals`;

      // POST /api/signal/:roomId
      if (request.method === 'POST') {
        try {
          const payload = await request.json();
          const signalEntry = {
            type: payload.type,
            senderCallsign: payload.senderCallsign || 'ANON',
            createdAt: Date.now(),
          };

          // If burn notice, also wipe drops immediately
          if (payload.type === 'burn_notice') {
            if (env?.SPYCOM_KV) {
              await env.SPYCOM_KV.delete(`room:${roomId}:drops`);
            } else {
              memoryStore.delete(`room:${roomId}:drops`);
            }
          }

          let signals = [];
          if (env?.SPYCOM_KV) {
            const raw = await env.SPYCOM_KV.get(kvKey, { type: 'json' });
            signals = Array.isArray(raw) ? raw : [];
          } else {
            signals = memoryStore.get(kvKey) || [];
          }

          signals.push(signalEntry);
          if (signals.length > 20) signals.shift();

          // 5-minute TTL for emergency signals
          if (env?.SPYCOM_KV) {
            await env.SPYCOM_KV.put(kvKey, JSON.stringify(signals), { expirationTtl: 300 });
          } else {
            memoryStore.set(kvKey, signals);
          }

          return new Response(
            JSON.stringify({ success: true, signal: signalEntry.type }),
            { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        } catch (err) {
          return new Response(JSON.stringify({ error: 'Malformed signal payload' }), {
            status: 400,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }
      }

      // GET /api/signal/:roomId
      if (request.method === 'GET') {
        const since = parseInt(url.searchParams.get('since') || '0', 10);
        let signals = [];

        if (env?.SPYCOM_KV) {
          const raw = await env.SPYCOM_KV.get(kvKey, { type: 'json' });
          signals = Array.isArray(raw) ? raw : [];
        } else {
          signals = memoryStore.get(kvKey) || [];
        }

        const filtered = signals.filter(s => s.createdAt > since);

        return new Response(
          JSON.stringify({ signals: filtered, serverTime: Date.now() }),
          { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
    }

    return new Response(JSON.stringify({ error: 'Route Not Found' }), {
      status: 404,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  },
};
