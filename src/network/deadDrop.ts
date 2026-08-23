import { EncryptedPayload } from '../crypto/encryption';

export interface NetworkMessagePayload {
  id: string;
  roomId: string;
  senderCallsign?: string;
  senderClientId?: string;
  encrypted: EncryptedPayload;
  createdAt: number;
  viewOnce?: boolean;
  isDream?: boolean;
  type?: 'message' | 'duress_signal' | 'burn_notice';
}

export interface DeadDropEntry {
  id: string;
  senderCallsign?: string;
  senderClientId?: string;
  encrypted: EncryptedPayload;
  createdAt: number;
  viewOnce?: boolean;
}

export interface DeadDropSignal {
  type: string;
  senderCallsign?: string;
  senderClientId?: string;
  createdAt: number;
}

export type PresenceMode = 'COM' | 'LONE' | 'OFFLINE';

// ============================================================================
// 🌐 GLOBAL CLOUDFLARE DEAD-DROP ENDPOINT CONFIGURATION
// ============================================================================
export const CLOUDFLARE_WORKER_URL = 'https://spycomapp-relay.duzcanemre.workers.dev';

// Unique random client instance ID for this app session
const MY_CLIENT_ID = 'client_' + Math.random().toString(36).substring(2, 10);

let syncIntervalHandle: any = null;
let lastSyncTimestamp = 0;
const processedMessageIds = new Set<string>();

export function getMyClientId(): string {
  return MY_CLIENT_ID;
}

export function getDeadDropEndpoint(): string {
  return (CLOUDFLARE_WORKER_URL || '').replace(/\/+$/, '');
}

/**
 * Resilient fetch with a 5-second timeout to the global Cloudflare Edge.
 */
async function deadDropFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const endpoint = getDeadDropEndpoint();
  if (!endpoint) {
    throw new Error('Cloudflare Worker URL is not configured.');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const url = `${endpoint}${path}`;
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('Network request timed out (5s)');
    }
    throw err;
  }
}

/**
 * Deposit an encrypted message blob into the 24-hour Dead Drop.
 */
export async function depositMessage(
  roomId: string,
  payload: NetworkMessagePayload
): Promise<boolean> {
  try {
    console.log(`[DEAD-DROP] Depositing payload ${payload.id} to room ${roomId}...`);

    // Track own message locally immediately so we never duplicate it upon polling
    processedMessageIds.add(payload.id);

    const response = await deadDropFetch(`/api/drop/${roomId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: payload.id,
        senderCallsign: payload.senderCallsign || '',
        senderClientId: MY_CLIENT_ID,
        encrypted: payload.encrypted,
        createdAt: payload.createdAt || Date.now(),
        viewOnce: payload.viewOnce,
      }),
    });

    if (!response.ok) {
      console.warn(`[DEAD-DROP] Edge returned HTTP ${response.status} on deposit`);
      return false;
    }

    console.log(`[DEAD-DROP] Successfully deposited message ${payload.id}`);
    return true;
  } catch (err) {
    console.error('[DEAD-DROP] Error depositing message:', err);
    return false;
  }
}

/**
 * Retrieve all unread dead drops deposited in this room.
 */
export async function retrieveDeadDrops(
  roomId: string,
  since: number = 0
): Promise<DeadDropEntry[]> {
  try {
    const response = await deadDropFetch(`/api/drop/${roomId}?since=${since}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return data.drops || [];
  } catch (err) {
    return [];
  }
}

/**
 * Send heartbeat and query presence mode ('COM' vs 'LONE').
 */
export async function updatePresence(
  roomId: string,
  callsign?: string
): Promise<PresenceMode> {
  try {
    const response = await deadDropFetch(`/api/presence/${roomId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: MY_CLIENT_ID,
        callsign: callsign || '',
      }),
    });

    if (!response.ok) {
      if (response.status === 404) return 'LONE';
      return 'OFFLINE';
    }
    const data = await response.json();
    return data.mode === 'COM' ? 'COM' : 'LONE';
  } catch (err) {
    return 'OFFLINE';
  }
}

/**
 * Broadcast an emergency or presence signal (Burn Notice / Duress Beacon / Peer Ping).
 */
export async function sendEmergencySignal(
  roomId: string,
  signalType: 'burn_notice' | 'duress_signal' | 'peer_ping',
  senderCallsign?: string
): Promise<boolean> {
  try {
    const response = await deadDropFetch(`/api/signal/${roomId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: signalType,
        senderCallsign: senderCallsign || '',
        senderClientId: MY_CLIENT_ID,
      }),
    });

    return response.ok;
  } catch (err) {
    return false;
  }
}

/**
 * Retrieve active signals for this room.
 */
export async function retrieveSignals(
  roomId: string,
  since: number = 0
): Promise<DeadDropSignal[]> {
  try {
    const response = await deadDropFetch(`/api/signal/${roomId}?since=${since}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) return [];
    const data = await response.json();
    return data.signals || [];
  } catch (err) {
    return [];
  }
}

let lastPingTime = 0;
let lastPeerSeenTime = 0;

/**
 * Start high-frequency live synchronization while operative is active in the room.
 */
export function startLiveSync(
  roomId: string,
  myCallsign: string,
  callbacks: {
    onMessage: (drop: DeadDropEntry) => void;
    onSignal: (signal: DeadDropSignal) => void;
    onPresenceChange: (presence: PresenceMode) => void;
  }
) {
  stopLiveSync();
  processedMessageIds.clear();
  lastPeerSeenTime = 0;
  lastPingTime = 0;

  const endpoint = getDeadDropEndpoint();
  if (!endpoint) {
    console.warn('[DEAD-DROP] Worker URL not set. Messages will queue locally.');
    callbacks.onPresenceChange('OFFLINE');
    return;
  }

  console.log(`[DEAD-DROP] Starting Live Sync for room: ${roomId} (Client: ${MY_CLIENT_ID})`);

  // Sync routine
  const performSync = async () => {
    try {
      const now = Date.now();

      // 1. Broadcast heartbeat ping every 2 seconds
      if (now - lastPingTime > 2000) {
        lastPingTime = now;
        sendEmergencySignal(roomId, 'peer_ping', myCallsign);
      }

      // 2. Fetch recent signals (last 10s) to detect peer presence and alerts
      const signals = await retrieveSignals(roomId, now - 10000);
      for (const sig of signals) {
        if (sig.senderClientId !== MY_CLIENT_ID) {
          if (sig.type === 'peer_ping') {
            lastPeerSeenTime = sig.createdAt || now;
          } else if (sig.type === 'burn_notice' || sig.type === 'duress_signal') {
            callbacks.onSignal(sig);
          }
        }
      }

      // 3. Evaluate presence mode: COM if peer seen within last 5 seconds, else LONE
      const isPeerOnline = (now - lastPeerSeenTime) < 5000;
      callbacks.onPresenceChange(isPeerOnline ? 'COM' : 'LONE');

      // 4. Fetch any new dead-drop messages
      const drops = await retrieveDeadDrops(roomId, lastSyncTimestamp);
      for (const drop of drops) {
        // Only deliver if we haven't processed this message ID yet
        if (!processedMessageIds.has(drop.id)) {
          processedMessageIds.add(drop.id);
          if (drop.createdAt > lastSyncTimestamp) {
            lastSyncTimestamp = drop.createdAt;
          }
          console.log(`[DEAD-DROP] Delivering incoming message ${drop.id}`);
          callbacks.onMessage(drop);
        }
      }
    } catch (e) {
      callbacks.onPresenceChange('OFFLINE');
    }
  };

  // Immediate first sweep
  performSync();

  // Active polling every 1.5 seconds while chat window is open
  syncIntervalHandle = setInterval(performSync, 1500);
}

/**
 * Stop live synchronization when leaving room to conserve battery and bandwidth.
 */
export function stopLiveSync() {
  if (syncIntervalHandle) {
    clearInterval(syncIntervalHandle);
    syncIntervalHandle = null;
  }
  lastSyncTimestamp = 0;
  console.log('[DEAD-DROP] Live sync stopped');
}
