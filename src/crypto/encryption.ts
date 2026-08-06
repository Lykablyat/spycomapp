import {
  pbkdf2Sync,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'react-native-quick-crypto';
import { Buffer } from '@craftzdog/react-native-buffer';

export interface EncryptedPayload {
  iv: string;       // Base64 IV (12 bytes for GCM)
  salt: string;     // Base64 salt
  ciphertext: string; // Base64 ciphertext
  authTag: string;  // Base64 GCM authentication tag
}

export async function encryptMessage(
  text: string, 
  password: string
): Promise<EncryptedPayload> {
  const salt = randomBytes(16);
  const iv = randomBytes(12); // 12 bytes standard for GCM
  
  const key = pbkdf2Sync(password, salt, 10000, 32, 'sha256');
  
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag();
  
  return {
    iv: Buffer.from(iv).toString('base64'),
    salt: Buffer.from(salt).toString('base64'),
    ciphertext: encrypted,
    authTag: Buffer.from(authTag).toString('base64'),
  };
}

export async function decryptMessage(
  payload: EncryptedPayload, 
  password: string
): Promise<string> {
  const salt = Buffer.from(payload.salt, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const authTag = Buffer.from(payload.authTag, 'base64');
  
  const key = pbkdf2Sync(password, salt, 10000, 32, 'sha256');
  
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(payload.ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

export async function hashRoomKey(password: string): Promise<string> {
  const hash = createHash('sha256')
    .update(`tactical_room_${password}`)
    .digest('hex');
  return hash.substring(0, 24);
}
