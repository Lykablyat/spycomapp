import { EncryptedPayload } from '../crypto/encryption';

export interface NetworkMessagePayload {
  id: string;
  roomId: string;
  senderCallsign: string;
  encrypted: EncryptedPayload;
  createdAt: number;
  viewOnce?: boolean;
  isDream?: boolean;
  type?: 'message' | 'duress_signal' | 'burn_notice';
}

export interface DeadDropEntry {
  id: string;
  senderCallsign: string;
  encrypted: EncryptedPayload;
  createdAt: number;
  viewOnce?: boolean;
}

export interface DeadDropSignal {
  type: string;
  senderCallsign: string;
  createdAt: number;
}

// Default Dead Drop Cloud Relay Endpoint
// You can deploy server/dead_drop_worker.js to Cloudflare Workers or server/server.js to any Node host
const DEFAULT_ENDPOINT = 'https://spycom-relay.onrender.com';

let currentEndpoint = DEFAULT_ENDPOINT;
let syncIntervalHandle: any = null;
let lastSyncTimestamp = 0;
const processedMessageIds = new Set<string>();

export function setDeadDropEndpoint(url?: string) {
  if (url && url.startsWith('http')) {
    currentEndpoint = url.replace(/\/+$/, '');
  } else {
    currentEndpoint = DEFAULT_ENDPOINT;
  }
  console.log(`[DEAD-DROP] Active endpoint set to: ${currentEndpoint}`);
}

export function getDeadDropEndpoint(): string {
  return currentEndpoint;
}

/**
 * Deposit an encrypted message blob into the 24-hour Dead Drop.
 */
export async function depositMessage(
  roomId: string,
  payload: NetworkMessagePayload
): Promise<boolean> {
  try {
    const url = `${currentEndpoint}/api/drop/${roomId}`;
    console.log(`[DEAD-DROP] Depositing payload ${payload.id} to ${url}...`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: payload.id,
        senderCallsign: payload.senderCallsign,
        encrypted: payload.encrypted,
        createdAt: payload.createdAt || Date.now(),
        viewOnce: payload.viewOnce,
      }),
    });

    if (!response.ok) {
      console.warn(`[DEAD-DROP] Server returned HTTP ${response.status} on deposit`);
      return false;
    }

    processedMessageIds.add(payload.id);
    console.log(`[DEAD-DROP] Successfully deposited message ${payload.id}`);
    return true;
  } catch (err) {
    console.error('[DEAD-DROP] Network error depositing message:', err);
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
    const url = `${currentEndpoint}/api/drop/${roomId}?since=${since}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return data.drops || [];
  } catch (err) {
    console.warn('[DEAD-DROP] Error fetching dead drops:', err);
    return [];
  }
}

/**
 * Broadcast an urgent emergency signal (Burn Notice / Duress Beacon).
 */
export async function sendEmergencySignal(
  roomId: string,
  signalType: 'burn_notice' | 'duress_signal',
  senderCallsign: string
): Promise<boolean> {
  try {
    const url = `${currentEndpoint}/api/signal/${roomId}`;
    console.log(`[DEAD-DROP] Broadcasting emergency signal '${signalType}' to ${url}...`);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: signalType,
        senderCallsign,
      }),
    });

    return response.ok;
  } catch (err) {
    console.error('[DEAD-DROP] Error sending emergency signal:', err);
    return false;
  }
}

/**
 * Retrieve active emergency signals for this room.
 */
export async function retrieveSignals(
  roomId: string,
  since: number = 0
): Promise<DeadDropSignal[]> {
  try {
    const url = `${currentEndpoint}/api/signal/${roomId}?since=${since}`;
    const response = await fetch(url, {
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

/**
 * Start high-frequency live synchronization while operative is active in the room.
 */
export function startLiveSync(
  roomId: string,
  myCallsign: string,
  callbacks: {
    onMessage: (drop: DeadDropEntry) => void;
    onSignal: (signal: DeadDropSignal) => void;
    onStatusChange: (connected: boolean) => void;
  }
) {
  stopLiveSync();
  processedMessageIds.clear();

  console.log(`[DEAD-DROP] Starting Live Sync for room: ${roomId}`);
  callbacks.onStatusChange(true);

  // Sync routine
  const performSync = async () => {
    try {
      // 1. Fetch any new dead-drop messages
      const drops = await retrieveDeadDrops(roomId, lastSyncTimestamp);
      for (const drop of drops) {
        if (!processedMessageIds.has(drop.id)) {
          processedMessageIds.add(drop.id);
          if (drop.createdAt > lastSyncTimestamp) {
            lastSyncTimestamp = drop.createdAt;
          }
          if (drop.senderCallsign !== myCallsign) {
            callbacks.onMessage(drop);
          }
        }
      }

      // 2. Fetch any emergency signals
      const signals = await retrieveSignals(roomId, Date.now() - 30000);
      for (const sig of signals) {
        if (sig.senderCallsign !== myCallsign) {
          callbacks.onSignal(sig);
        }
      }

      callbacks.onStatusChange(true);
    } catch (e) {
      console.warn('[DEAD-DROP] Sync cycle warning:', e);
    }
  };

  // Immediate first fetch (fetches up to 24h past history from dead drop)
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
