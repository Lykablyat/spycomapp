# SpyCom (WIP)

> [!WARNING]
> **Work In Progress (WIP)**: This app is currently under active development and testing.

SpyCom is a tactical, highly secure, End-to-End Encrypted (E2EE) mobile messaging application designed for high-privacy 2-person communication. 

*Personal App Made As A Birthday Gift.*

## 🔒 Architecture & Core Principles
* **100% Stateless Relay**: Uses a lightweight Node.js/Socket.IO backend that instantly forwards messages and immediately discards them. It stores zero persistent data.
* **Local Storage Only**: All messages are stored exclusively on your local device using `expo-sqlite`. No cloud databases are used.
* **Military-Grade E2EE**: Messages are encrypted via `react-native-quick-crypto` using AES-256-GCM. Encryption keys are securely derived from a shared connection password using PBKDF2.

## ⚙️ Tactical Features
* **Duress Code Protocol**: Entering a specific "fake" password logs the user in but silently triggers a local device wipe and broadcasts a distress signal to the connected peer.
* **Panic Button / Burn Notice**: Instantly wipes the local SQLite database and sends a `BURN_NOTICE` over WebSockets to self-destruct the peer device's data.
* **Decoy UI**: Upon booting a "burned" state, the app loads a fully functional Decoy Calculator interface to hide its true purpose.
* **Dream Room**: A volatile, in-memory-only chat session that bypasses the SQLite database entirely. Messages are destroyed instantly upon exiting via garbage collection.
* **View Once (Self-Destruct)**: Time-To-Live (TTL) functionality where messages permanently disappear from the database seconds after being viewed.

## 🛠️ Technology Stack
* **Frontend**: React Native, Expo (SDK 54), NativeWind (TailwindCSS)
* **Backend Relay**: Node.js, Socket.IO
* **Cryptography**: `react-native-quick-crypto`

## 🚀 Local Development
Because SpyCom uses custom native cryptography modules, it **cannot** be tested on standard Expo Go.
1. Start the relay server: `cd server && npm install && node server.js`
2. Build the custom Dev Client locally: `eas build --platform android --profile preview --local` (or `npx expo run:android`)
