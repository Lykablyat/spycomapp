import * as SQLite from 'expo-sqlite';
import { IMessage } from 'react-native-gifted-chat';

const DB_NAME = 'tactical_messenger.db';

let dbInstance: SQLite.SQLiteDatabase | null = null;

interface MessageRow {
  id: string;
  text: string;
  createdAt: number;
  userId: number;
  userName: string;
}

export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!dbInstance) {
    dbInstance = await SQLite.openDatabaseAsync(DB_NAME);
  }
  return dbInstance;
}

export async function initDatabase(): Promise<void> {
  const db = await getDatabase();
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      text TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      userName TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);
}

export async function fetchStoredMessages(): Promise<IMessage[]> {
  try {
    const db = await getDatabase();
    const rows = (await db.getAllAsync('SELECT * FROM messages ORDER BY createdAt DESC;')) as MessageRow[];

    return rows.map((row: MessageRow) => ({
      _id: row.id,
      text: row.text,
      createdAt: new Date(row.createdAt),
      user: {
        _id: row.userId,
        name: row.userName,
      },
    }));
  } catch (error) {
    console.error('Failed to fetch messages from SQLite database:', error);
    return [];
  }
}

export async function saveMessage(message: IMessage): Promise<void> {
  try {
    const db = await getDatabase();
    const msgId = String(message._id);
    const createdAtTime =
      message.createdAt instanceof Date
        ? message.createdAt.getTime()
        : new Date(message.createdAt).getTime();

    const userId = typeof message.user._id === 'number' ? message.user._id : 1;
    const userName = message.user.name || 'OPERATOR';

    await db.runAsync(
      `INSERT OR REPLACE INTO messages (id, text, createdAt, userId, userName) VALUES (?, ?, ?, ?, ?);`,
      [msgId, message.text, createdAtTime, userId, userName]
    );
  } catch (error) {
    console.error('Failed to save message to SQLite database:', error);
  }
}

export async function clearAllMessages(): Promise<void> {
  try {
    const db = await getDatabase();
    await db.runAsync('DELETE FROM messages;');
  } catch (error) {
    console.error('Failed to clear SQLite messages:', error);
  }
}

export async function deleteMessageById(id: string): Promise<void> {
  try {
    const db = await getDatabase();
    await db.runAsync('DELETE FROM messages WHERE id = ?;', [String(id)]);
  } catch (error) {
    console.error('Failed to delete message from SQLite database:', error);
  }
}


export async function getBurnedState(): Promise<boolean> {
  try {
    const db = await getDatabase();
    const row = (await db.getFirstAsync(
      "SELECT value FROM app_config WHERE key = 'isBurned';"
    )) as { value: string } | null;
    return row ? row.value === 'true' : false;
  } catch (error) {
    console.error('Failed to read burned state from SQLite:', error);
    return false;
  }
}

export async function setBurnedState(burned: boolean): Promise<void> {
  try {
    const db = await getDatabase();
    await db.runAsync(
      "INSERT OR REPLACE INTO app_config (key, value) VALUES ('isBurned', ?);",
      [burned ? 'true' : 'false']
    );
  } catch (error) {
    console.error('Failed to save burned state to SQLite:', error);
  }
}

