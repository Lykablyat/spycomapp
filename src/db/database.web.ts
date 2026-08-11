import { IMessage } from 'react-native-gifted-chat';

const STORAGE_KEY = 'tactical_messenger_web_messages';

export async function initDatabase(): Promise<void> {
  // Web initialization - localStorage is ready by default
  return;
}

export async function fetchStoredMessages(roomId: string): Promise<IMessage[]> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    const data = window.localStorage.getItem(`${STORAGE_KEY}_${roomId}`);
    if (!data) return [];
    const parsed = JSON.parse(data);
    return parsed.map((item: IMessage & { createdAt: string | number }) => ({
      ...item,
      createdAt: new Date(item.createdAt),
    }));
  } catch (error) {
    console.error('Failed to fetch messages from web localStorage:', error);
    return [];
  }
}

export async function saveMessage(message: IMessage, roomId: string): Promise<void> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const currentMessages = await fetchStoredMessages(roomId);
    // Check if message already exists
    const exists = currentMessages.some((m) => String(m._id) === String(message._id));
    let updated: IMessage[];
    if (exists) {
      updated = currentMessages.map((m) => (String(m._id) === String(message._id) ? message : m));
    } else {
      updated = [message, ...currentMessages];
    }
    window.localStorage.setItem(`${STORAGE_KEY}_${roomId}`, JSON.stringify(updated));
  } catch (error) {
    console.error('Failed to save message to web localStorage:', error);
  }
}

export async function clearAllMessages(): Promise<void> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear web localStorage messages:', error);
  }
}

export async function deleteMessageById(id: string): Promise<void> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const currentMessages = await fetchStoredMessages();
    const filtered = currentMessages.filter((m) => String(m._id) !== String(id));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
  } catch (error) {
    console.error('Failed to delete message from web localStorage:', error);
  }
}


export async function getBurnedState(): Promise<boolean> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    return window.localStorage.getItem('tactical_messenger_is_burned') === 'true';
  } catch (error) {
    return false;
  }
}

export async function setBurnedState(burned: boolean): Promise<void> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem('tactical_messenger_is_burned', burned ? 'true' : 'false');
  } catch (error) {
    console.error('Failed to set burned state in web localStorage:', error);
  }
}

export async function getDuressCode(): Promise<string | null> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage.getItem('tactical_messenger_duress_code');
  } catch (error) {
    return null;
  }
}

export async function saveDuressCode(code: string): Promise<void> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem('tactical_messenger_duress_code', code);
  } catch (error) {
    console.error('Failed to save duress code in web localStorage:', error);
  }
}
