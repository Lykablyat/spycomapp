import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { GiftedChat, Bubble, InputToolbar, Send, IMessage, BubbleProps, InputToolbarProps, SendProps } from 'react-native-gifted-chat';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import {
  initDatabase,
  saveMessage,
  fetchStoredMessages,
  clearAllMessages,
  setBurnedState,
  deleteMessageById,
} from '@/db/database';
import { encryptMessage, decryptMessage, hashRoomKey } from '@/crypto/encryption';
import { connectSocket, disconnectSocket, getSocket, NetworkMessagePayload } from '@/network/socket';

export default function ChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();

  // Params
  const callsign = (params.callsign as string) || 'UNKNOWN';
  const connectionKey = params.connectionKey as string;
  const serverUrl = params.serverUrl as string;
  const isDuressAuth = params.isDuress === 'true';

  // Refs for callbacks
  const connectionKeyRef = useRef(connectionKey);
  const callsignRef = useRef(callsign);

  // State
  const [messages, setMessages] = useState<IMessage[]>([]);
  const [roomId, setRoomId] = useState<string>('');
  const [isConnected, setIsConnected] = useState(false);
  const [peerCallsign, setPeerCallsign] = useState<string | null>(null);
  const [duressAlertReceived, setDuressAlertReceived] = useState(false);
  
  // Tactical options
  const [ttlSeconds, setTtlSeconds] = useState<number>(0);
  const [isDreamRoom, setIsDreamRoom] = useState<boolean>(false);

  // Keep refs for active configuration
  const isDreamRoomRef = useRef(isDreamRoom);
  isDreamRoomRef.current = isDreamRoom;

  // Active TTL self-destruct timers dictionary to clear timeouts on cleanup
  const activeTimersRef = useRef<{ [msgId: string]: ReturnType<typeof setTimeout> }>({});

  // Helper to schedule message self-destruction
  const scheduleSelfDestruct = useCallback((msgId: string, seconds?: number) => {
    if (!seconds || seconds <= 0) return;

    console.log(`[DEV_ONLY][TTL] Scheduling self-destruct for message ${msgId} in ${seconds}s`);

    const timer = setTimeout(async () => {
      console.log(`[DEV_ONLY][TTL] Expiring message ${msgId} now!`);

      // Remove from UI state
      setMessages((prev) => prev.filter((m) => String(m._id) !== String(msgId)));

      // Remove from SQLite
      if (!isDreamRoomRef.current) {
        await deleteMessageById(msgId);
      }
      
      delete activeTimersRef.current[msgId];
    }, seconds * 1000);

    activeTimersRef.current[msgId] = timer;
  }, []);

  // Update refs when props change
  useEffect(() => {
    connectionKeyRef.current = connectionKey;
    callsignRef.current = callsign;
  }, [connectionKey, callsign]);

  // Handle Duress Authentication wipe on boot if triggered
  useEffect(() => {
    if (isDuressAuth) {
      console.log('[DEV_ONLY][DURESS] App booted under Duress Code! Performing instant wipe...');
      (async () => {
        await clearAllMessages();
        setMessages([]);
      })();
    }
  }, [isDuressAuth]);

  // Initialize SQLite database and Socket.IO connection
  useEffect(() => {
    let activeSocket: ReturnType<typeof connectSocket> | null = null;

    async function initChat() {
      if (!connectionKey) return;

      try {
        await initDatabase();

        // Load existing history if not a dream room
        if (!isDreamRoom) {
          const storedMessages = await fetchStoredMessages();
          setMessages(storedMessages);
        }

        const derivedRoomId = await hashRoomKey(connectionKey);
        setRoomId(derivedRoomId);

        console.log(`[DEV_ONLY][CLIENT] Init chat network with serverUrl=${serverUrl}, room=${derivedRoomId}`);

        // Connect socket
        activeSocket = connectSocket(serverUrl);
        
        const handleConnect = () => {
          setIsConnected(true);
          console.log(`[DEV_ONLY][CLIENT] Socket connected (${activeSocket?.id})! Joining room ${derivedRoomId} as ${callsign}`);
          activeSocket?.emit('join_room', { roomId: derivedRoomId, callsign });

          // If user logged in under duress code, silently emit distress signal to peer
          if (isDuressAuth) {
            console.log('[DEV_ONLY][DURESS] Emitting silent distress alert to room...');
            activeSocket?.emit('duress_signal', { roomId: derivedRoomId, senderCallsign: callsign });
          }
        };

        if (activeSocket.connected) {
          handleConnect();
        }

        activeSocket?.on('disconnect', () => {
          console.log('[DEV_ONLY][CLIENT] Socket disconnected');
          setIsConnected(false);
        });

        activeSocket?.on('peer_joined', (data: { callsign?: string }) => {
          console.log('[DEV_ONLY][CLIENT] Peer joined:', data);
          if (data?.callsign) {
            setPeerCallsign(data.callsign);
          }
        });

        // Listen for incoming encrypted messages from peer
        activeSocket?.on('receive_message', async (payload: NetworkMessagePayload) => {
          console.log('[DEV_ONLY][CLIENT] Received payload over socket (encrypted)');

          if (payload.senderCallsign === callsignRef.current) {
            return;
          }

          try {
            const decryptedText = await decryptMessage(payload.encrypted, connectionKeyRef.current);

            const msgId = payload.id || String(Date.now());
            const incomingMsg: IMessage = {
              _id: msgId,
              text: decryptedText,
              createdAt: new Date(payload.createdAt),
              user: {
                _id: 2,
                name: payload.senderCallsign,
              },
            };

            setMessages((previousMessages) => GiftedChat.append(previousMessages, [incomingMsg]));

            // Persist to DB if not Dream Room
            if (!isDreamRoomRef.current) {
              await saveMessage(incomingMsg);
            }

            // Schedule TTL expiration if applicable
            if (payload.ttl && payload.ttl > 0) {
              scheduleSelfDestruct(msgId, payload.ttl);
            }
          } catch (err) {
            console.error('[DEV_ONLY] Failed decrypting incoming socket message:', err);
          }
        });

        // Listen for peer duress alert
        activeSocket?.on('duress_signal', (payload: { senderCallsign?: string }) => {
          console.warn('[DEV_ONLY][DURESS ALERT] RECEIVED DISTRESS SIGNAL FROM PEER!', payload);
          setDuressAlertReceived(true);
        });

        // Listen for burn notice from peer
        activeSocket?.on('burn_notice', async () => {
          console.log('[DEV_ONLY][CLIENT] BURN NOTICE received! Wiping local storage...');
          await setBurnedState(true);
          await clearAllMessages();
          setMessages([]);
          router.replace('/decoy');
        });
      } catch (err) {
        console.error('[DEV_ONLY] Failed initializing chat network:', err);
      }
    }

    initChat();

    return () => {
      if (activeSocket) {
        activeSocket.removeAllListeners();
      }
    };
  }, [callsign, connectionKey, serverUrl, isDuressAuth, scheduleSelfDestruct]);

  const onSend = useCallback(
    async (newMessages: IMessage[] = []) => {
      const msgToSend = newMessages[0];
      if (!msgToSend) return;

      console.log(`[DEV_ONLY][CLIENT] Sending encrypted message (Dream=${isDreamRoom}, TTL=${ttlSeconds}s)`);

      // Append locally
      setMessages((previousMessages) => GiftedChat.append(previousMessages, newMessages));

      const msgId = String(msgToSend._id);
      const timestamp = new Date(msgToSend.createdAt).getTime();

      // 1. Write to local database (if not a Dream Room)
      if (!isDreamRoom) {
        await saveMessage(msgToSend);
      }

      // If TTL is set, schedule local destruction
      if (ttlSeconds > 0) {
        scheduleSelfDestruct(msgId, ttlSeconds);
      }

      // 2. Encrypt & transmit over Socket.IO relay
      try {
        const encrypted = await encryptMessage(msgToSend.text, connectionKey);
        const socket = getSocket() || connectSocket(serverUrl);
        const derivedRoomId = roomId || (await hashRoomKey(connectionKey));

        console.log(`[DEV_ONLY][CLIENT] Transmitting encrypted payload to room ${derivedRoomId}...`);

        const networkPayload: NetworkMessagePayload = {
          id: msgId,
          roomId: derivedRoomId,
          senderCallsign: callsign,
          encrypted,
          createdAt: timestamp,
          ttl: ttlSeconds > 0 ? ttlSeconds : undefined,
        };

        socket.emit('send_message', networkPayload);
      } catch (err) {
        console.error('[DEV_ONLY] Failed encrypting/emitting message:', err);
      }
    },
    [callsign, connectionKey, roomId, serverUrl, isDreamRoom, ttlSeconds, scheduleSelfDestruct]
  );

  const handlePanicPress = async () => {
    try {
      const socket = getSocket() || connectSocket(serverUrl);
      const derivedRoomId = roomId || (await hashRoomKey(connectionKey));
      socket.emit('burn_notice', { roomId: derivedRoomId });
    } catch (err) {
      console.error('[DEV_ONLY] Failed emitting burn notice:', err);
    }

    await setBurnedState(true);
    await clearAllMessages();
    router.replace('/decoy');
  };

  const renderBubble = (props: BubbleProps<IMessage>) => {
    return (
      <Bubble
        {...props}
        wrapperStyle={{
          right: {
            backgroundColor: isDreamRoom ? '#C084FC' : '#00F0FF',
            borderRadius: 8,
            borderBottomRightRadius: 2,
            padding: 2,
          },
          left: {
            backgroundColor: '#1E293B',
            borderRadius: 8,
            borderBottomLeftRadius: 2,
            padding: 2,
          },
        }}
        textStyle={{
          right: { color: isDreamRoom ? '#FFFFFF' : '#080C14', fontWeight: '500' },
          left: { color: '#F8FAFC', fontWeight: '500' },
        }}
      />
    );
  };

  const renderInputToolbar = (props: InputToolbarProps<IMessage>) => {
    return (
      <InputToolbar
        {...props}
        containerStyle={{
          backgroundColor: '#0F172A',
          borderTopColor: '#1E293B',
          borderTopWidth: 1,
          paddingTop: 4,
          paddingBottom: Platform.OS === 'android' ? 4 : 0,
        }}
        primaryStyle={{ alignItems: 'center' }}
      />
    );
  };

  const renderSend = (props: SendProps<IMessage>) => {
    return (
      <Send {...props} containerStyle={{ justifyContent: 'center', paddingHorizontal: 8 }}>
        <View className={`w-9 h-9 rounded-full justify-center items-center ${isDreamRoom ? 'bg-[#C084FC]' : 'bg-tactical-cyan'}`}>
          <Ionicons name="send" size={16} color={isDreamRoom ? '#FFFFFF' : '#080C14'} style={{ marginLeft: 2 }} />
        </View>
      </Send>
    );
  };

  return (
    <SafeAreaView className={`flex-1 ${isDreamRoom ? 'bg-[#581C87]' : 'bg-tactical-bg'}`} edges={['top', 'bottom', 'left', 'right']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        {/* Header bar */}
        <View className="flex-row items-center justify-between px-4 py-3 bg-[#080C14] border-b border-tactical-border">
          <View className="flex-row items-center gap-2">
            <TouchableOpacity onPress={() => router.replace('/')} className="p-1">
              <Ionicons name="chevron-back" size={24} color={isDreamRoom ? '#C084FC' : '#00F0FF'} />
            </TouchableOpacity>
            <View>
              <Text className="text-white text-[15px] font-bold">
                {isDreamRoom ? 'DREAM ROOM' : 'SECURE COMMS'}
              </Text>
              <View className="flex-row items-center mt-1">
                <View className={`w-2 h-2 rounded-full mr-1.5 ${isConnected ? 'bg-[#00FF66]' : 'bg-[#EF4444]'}`} />
                <Text className="text-tactical-textMuted text-[10px] font-bold tracking-widest" style={{ fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}>
                  {isConnected ? 'LINK ACTIVE' : 'CONNECTING...'}
                </Text>
              </View>
            </View>
          </View>

          <View className="flex-row items-center gap-3">
            {/* TTL Toggle */}
            <TouchableOpacity
              onPress={() => setTtlSeconds(prev => prev === 0 ? 30 : prev === 30 ? 60 : 0)}
              className={`flex-row items-center px-2 py-1 rounded-md border ${ttlSeconds > 0 ? 'bg-[#450A0A] border-tactical-red' : 'bg-tactical-card border-tactical-borderLight'}`}
            >
              <MaterialCommunityIcons 
                name="timer-sand" 
                size={14} 
                color={ttlSeconds > 0 ? '#EF4444' : '#94A3B8'} 
              />
              {ttlSeconds > 0 && (
                <Text className="text-tactical-red text-[10px] font-bold ml-1">{ttlSeconds}s</Text>
              )}
            </TouchableOpacity>

            {/* Dream Room Toggle */}
            <TouchableOpacity
              onPress={() => {
                setIsDreamRoom(!isDreamRoom);
                if (!isDreamRoom) setMessages([]);
              }}
              className={`p-1.5 rounded-md border ${isDreamRoom ? 'bg-[#3B0764] border-[#C084FC]' : 'bg-tactical-card border-tactical-borderLight'}`}
            >
              <Ionicons 
                name={isDreamRoom ? 'cloudy-night' : 'cloud-outline'} 
                size={18} 
                color={isDreamRoom ? '#C084FC' : '#94A3B8'} 
              />
            </TouchableOpacity>

            {/* Burn Button */}
            <TouchableOpacity
              onPress={handlePanicPress}
              className="bg-tactical-redDark px-3 py-1.5 rounded-md shadow-md"
              style={{ elevation: 3 }}
            >
              <Text className="text-white text-[10px] font-black tracking-widest">BURN</Text>
            </TouchableOpacity>
          </View>
        </View>

        {duressAlertReceived && (
          <View className="bg-[#450A0A] py-2 px-4 border-b border-tactical-red flex-row items-center justify-center gap-2">
            <MaterialCommunityIcons name="shield-alert" size={16} color="#EF4444" />
            <Text className="text-tactical-red text-[10px] font-black tracking-widest text-center" style={{ fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}>
              DISTRESS SIGNAL RECEIVED FROM PEER
            </Text>
          </View>
        )}
        
        {peerCallsign && !duressAlertReceived && (
           <View className="bg-tactical-card py-1.5 px-4 border-b border-tactical-border flex-row items-center justify-center gap-2">
             <Text className="text-tactical-textMuted text-[9px] font-bold tracking-widest text-center" style={{ fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}>
               PEER IN ROOM: {peerCallsign}
             </Text>
           </View>
        )}

        <View className="flex-1 px-1">
          <GiftedChat
            messages={messages}
            onSend={(newMessages) => onSend(newMessages)}
            user={{ _id: 1, name: callsign }}
            renderBubble={renderBubble}
            renderInputToolbar={renderInputToolbar}
            renderSend={renderSend}
            textInputProps={{
              style: {
                color: '#F8FAFC',
                paddingHorizontal: 12,
                paddingTop: 10,
                fontSize: 15,
                lineHeight: 20,
              },
              placeholderTextColor: '#64748B',
            }}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
