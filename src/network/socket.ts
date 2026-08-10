import { io, Socket } from 'socket.io-client';
import { EncryptedPayload } from '../crypto/encryption';

export interface NetworkMessagePayload {
  id: string;
  roomId: string;
  senderCallsign: string;
  encrypted: EncryptedPayload;
  createdAt: number;
  viewOnce?: boolean;
  isDream?: boolean;
}


let socketInstance: Socket | null = null;
let activeServerUrl: string | null = null;

/**
 * Connect or reuse Socket.IO client connection for the specified server URL.
 */
export function connectSocket(serverUrl: string): Socket {
  const normalizedUrl = serverUrl.trim();

  // If connected to a different server URL, disconnect first to switch endpoints
  if (socketInstance && activeServerUrl !== normalizedUrl) {
    console.log(`[DEV_ONLY][SOCKET] Switching relay endpoint from ${activeServerUrl} to ${normalizedUrl}`);
    socketInstance.removeAllListeners();
    socketInstance.disconnect();
    socketInstance = null;
  }

  if (!socketInstance || !socketInstance.connected) {
    activeServerUrl = normalizedUrl;
    console.log(`[DEV_ONLY][SOCKET] Connecting to relay server at ${normalizedUrl}...`);

    socketInstance = io(normalizedUrl, {
      transports: ['websocket', 'polling'],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 1000,
      timeout: 10000,
    });
  }
  return socketInstance;
}

export function getSocket(): Socket | null {
  return socketInstance;
}

export function disconnectSocket() {
  if (socketInstance) {
    console.log('[DEV_ONLY][SOCKET] Disconnecting active socket instance...');
    socketInstance.removeAllListeners();
    socketInstance.disconnect();
    socketInstance = null;
    activeServerUrl = null;
  }
}
