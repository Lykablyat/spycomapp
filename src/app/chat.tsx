import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Modal,
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
} from '@/db/database';
import { encryptMessage, decryptMessage, hashRoomKey } from '@/crypto/encryption';
import { connectSocket, disconnectSocket, getSocket, NetworkMessagePayload } from '@/network/socket';
import { setAppIcon } from '@howincodes/expo-dynamic-app-icon';

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
  const [isDreamRoom, setIsDreamRoom] = useState<boolean>(false);
  const [isViewOnce, setIsViewOnce] = useState(false);
  const [revealedMessage, setRevealedMessage] = useState<{
    id: string; text: string; sender: string;
  } | null>(null);

  // Keep refs for active configuration
  const isDreamRoomRef = useRef(isDreamRoom);
  isDreamRoomRef.current = isDreamRoom;

  // View Once data store: msgId → { originalText, senderCallsign, isOwn }
  const viewOnceDataRef = useRef<Record<string, {
    originalText: string;
    senderCallsign: string;
    isOwn: boolean;
  }>>({});

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
        try {
          await setAppIcon('calculator');
        } catch (e) {
          console.error('Failed to set disguise app icon', e);
        }
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

        activeSocket?.on('connect', handleConnect);

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

            // Handle View Once messages — store in memory only, never persisted
            if (payload.viewOnce) {
              viewOnceDataRef.current[msgId] = {
                originalText: decryptedText,
                senderCallsign: payload.senderCallsign,
                isOwn: false,
              };

              const sealedMsg: IMessage = {
                _id: msgId,
                text: '🔒 CLASSIFIED INTEL',
                createdAt: new Date(payload.createdAt),
                user: { _id: 2, name: payload.senderCallsign },
              };
              setMessages((prev) => GiftedChat.append(prev, [sealedMsg]));
              // View Once received messages are NEVER persisted to SQLite
              return;
            }

            // Normal message
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
          try {
            await setAppIcon('calculator');
          } catch (e) {
            console.error('Failed to set disguise app icon', e);
          }
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
      disconnectSocket();
    };
  }, [callsign, connectionKey, serverUrl, isDuressAuth]);

  // View Once handlers
  const handleRevealViewOnce = useCallback((msgId: string) => {
    const data = viewOnceDataRef.current[msgId];
    if (data && !data.isOwn) {
      setRevealedMessage({ id: msgId, text: data.originalText, sender: data.senderCallsign });
    }
  }, []);

  const handleBurnViewOnce = useCallback((msgId: string) => {
    // Remove from messages state
    setMessages((prev) => prev.filter((m) => String(m._id) !== msgId));
    // Remove from viewOnce data
    delete viewOnceDataRef.current[msgId];
    // Close modal
    setRevealedMessage(null);
    // No SQLite deletion needed — view-once received messages were never persisted
  }, []);

  const onSend = useCallback(
    async (newMessages: IMessage[] = []) => {
      const msgToSend = newMessages[0];
      if (!msgToSend) return;

      const msgId = String(msgToSend._id);
      const timestamp = new Date(msgToSend.createdAt).getTime();
      const sendingViewOnce = isViewOnce;

      console.log(`[DEV_ONLY][CLIENT] Sending encrypted message (Dream=${isDreamRoom}, ViewOnce=${sendingViewOnce})`);

      if (sendingViewOnce) {
        // Store in viewOnce map so sender sees a special bubble
        viewOnceDataRef.current[msgId] = {
          originalText: msgToSend.text,
          senderCallsign: callsign,
          isOwn: true,
        };

        // Append placeholder to local UI (sender can never re-read)
        const placeholderMsg: IMessage = {
          ...msgToSend,
          text: '📨 ONE-TIME LETTER SENT',
        };
        setMessages((prev) => GiftedChat.append(prev, [placeholderMsg]));

        // Persist placeholder (not real text) to SQLite
        if (!isDreamRoom) {
          await saveMessage(placeholderMsg);
        }
      } else {
        // Normal message flow
        setMessages((prev) => GiftedChat.append(prev, newMessages));

        if (!isDreamRoom) {
          await saveMessage(msgToSend);
        }
      }

      // Encrypt the REAL text and transmit over Socket.IO relay
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
          viewOnce: sendingViewOnce || undefined,
        };

        socket.emit('send_message', networkPayload);
      } catch (err) {
        console.error('[DEV_ONLY] Failed encrypting/emitting message:', err);
      }
    },
    [callsign, connectionKey, roomId, serverUrl, isDreamRoom, isViewOnce]
  );

  const handlePanicPress = async () => {
    try {
      const socket = getSocket() || connectSocket(serverUrl);
      const derivedRoomId = roomId || (await hashRoomKey(connectionKey));
      socket.emit('burn_notice', { roomId: derivedRoomId });
    } catch (err) {
      console.error('[DEV_ONLY] Failed emitting burn notice:', err);
    }

    try {
      await setAppIcon('calculator');
    } catch (e) {
      console.error('Failed to set disguise app icon', e);
    }
    await setBurnedState(true);
    await clearAllMessages();
    router.replace('/decoy');
  };

  const renderBubble = (props: BubbleProps<IMessage>) => {
    const msgId = String(props.currentMessage?._id);
    const viewOnceInfo = viewOnceDataRef.current[msgId];

    // Received view-once message — sealed letter card (tap to reveal)
    if (viewOnceInfo && !viewOnceInfo.isOwn) {
      return (
        <TouchableOpacity
          onPress={() => handleRevealViewOnce(msgId)}
          activeOpacity={0.7}
          style={{ marginBottom: 8, marginLeft: 8, maxWidth: '75%' }}
        >
          <View style={{
            backgroundColor: '#1A0A2E',
            borderWidth: 1.5,
            borderColor: '#F59E0B',
            borderStyle: 'dashed',
            borderRadius: 12,
            padding: 16,
            alignItems: 'center',
            gap: 6,
          }}>
            <Ionicons name="lock-closed" size={24} color="#F59E0B" />
            <Text style={{
              color: '#F59E0B',
              fontSize: 11,
              fontWeight: '900',
              letterSpacing: 2,
              fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
            }}>CLASSIFIED INTEL</Text>
            <Text style={{
              color: '#D97706',
              fontSize: 9,
              fontWeight: '700',
              letterSpacing: 1,
              fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
            }}>TAP TO REVEAL</Text>
          </View>
        </TouchableOpacity>
      );
    }

    // Sent view-once message — letter sent indicator
    if (viewOnceInfo && viewOnceInfo.isOwn) {
      return (
        <View style={{ marginBottom: 8, marginRight: 8, maxWidth: '75%' }}>
          <View style={{
            backgroundColor: '#1C1917',
            borderWidth: 1,
            borderColor: '#78716C',
            borderRadius: 12,
            padding: 14,
            alignItems: 'center',
            gap: 4,
            flexDirection: 'row',
          }}>
            <Ionicons name="mail-outline" size={18} color="#A8A29E" />
            <Text style={{
              color: '#A8A29E',
              fontSize: 10,
              fontWeight: '800',
              letterSpacing: 1.5,
              marginLeft: 6,
              fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
            }}>ONE-TIME LETTER SENT</Text>
          </View>
        </View>
      );
    }

    // Normal message bubble
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
        <View style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: isViewOnce ? '#F59E0B' : isDreamRoom ? '#C084FC' : '#00F0FF',
        }}>
          <Ionicons
            name={isViewOnce ? 'mail' : 'send'}
            size={16}
            color={isViewOnce ? '#1C1917' : isDreamRoom ? '#FFFFFF' : '#080C14'}
            style={{ marginLeft: isViewOnce ? 0 : 2 }}
          />
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
            {/* View Once Toggle */}
            <TouchableOpacity
              onPress={() => setIsViewOnce(!isViewOnce)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 6,
                borderWidth: 1,
                backgroundColor: isViewOnce ? '#451A03' : '#0F172A',
                borderColor: isViewOnce ? '#F59E0B' : '#334155',
              }}
            >
              <Ionicons
                name={isViewOnce ? 'mail' : 'mail-outline'}
                size={14}
                color={isViewOnce ? '#F59E0B' : '#94A3B8'}
              />
              {isViewOnce && (
                <Text style={{
                  color: '#F59E0B',
                  fontSize: 9,
                  fontWeight: '800',
                  marginLeft: 4,
                  letterSpacing: 0.5,
                  fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                }}>1x</Text>
              )}
            </TouchableOpacity>

            {/* Dream Room Toggle */}
            <TouchableOpacity
              onPress={() => {
                if (isDreamRoom) {
                  // Exiting Dream Room — wipe volatile state, reload from SQLite
                  setIsDreamRoom(false);
                  viewOnceDataRef.current = {};
                  fetchStoredMessages().then(setMessages);
                } else {
                  // Entering Dream Room — clear view, go volatile
                  setIsDreamRoom(true);
                  viewOnceDataRef.current = {};
                  setMessages([]);
                }
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

        {/* View Once active indicator banner */}
        {isViewOnce && (
          <View style={{
            backgroundColor: '#451A03',
            borderBottomWidth: 1,
            borderBottomColor: '#F59E0B',
            paddingVertical: 6,
            paddingHorizontal: 16,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}>
            <Ionicons name="mail" size={12} color="#F59E0B" />
            <Text style={{
              color: '#F59E0B',
              fontSize: 9,
              fontWeight: '900',
              letterSpacing: 1.5,
              fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
            }}>VIEW ONCE — NEXT MESSAGE IS A ONE-TIME LETTER</Text>
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

        {/* View Once Reveal Modal */}
        <Modal
          visible={revealedMessage !== null}
          transparent
          animationType="fade"
          onRequestClose={() => revealedMessage && handleBurnViewOnce(revealedMessage.id)}
        >
          <View style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.85)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 24,
          }}>
            <View style={{
              backgroundColor: '#0F172A',
              borderWidth: 1.5,
              borderColor: '#F59E0B',
              borderRadius: 16,
              padding: 24,
              width: '100%',
              maxWidth: 360,
              gap: 16,
            }}>
              {/* Modal Header */}
              <View style={{ alignItems: 'center', gap: 8 }}>
                <Ionicons name="lock-open" size={28} color="#F59E0B" />
                <Text style={{
                  color: '#F59E0B',
                  fontSize: 11,
                  fontWeight: '900',
                  letterSpacing: 2,
                  fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                }}>CLASSIFIED INTEL</Text>
                <Text style={{
                  color: '#94A3B8',
                  fontSize: 9,
                  fontWeight: '700',
                  letterSpacing: 1,
                  fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                }}>FROM: {revealedMessage?.sender || 'UNKNOWN'}</Text>
              </View>

              {/* Decrypted Message Content */}
              <View style={{
                backgroundColor: '#1E293B',
                borderRadius: 8,
                padding: 16,
                borderWidth: 1,
                borderColor: '#334155',
              }}>
                <Text style={{
                  color: '#F8FAFC',
                  fontSize: 16,
                  lineHeight: 24,
                  fontWeight: '500',
                }}>{revealedMessage?.text}</Text>
              </View>

              {/* Destruction Warning */}
              <Text style={{
                color: '#EF4444',
                fontSize: 8,
                fontWeight: '800',
                letterSpacing: 1,
                textAlign: 'center',
                fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
              }}>⚠ THIS MESSAGE WILL BE DESTROYED ON CLOSE</Text>

              {/* Burn & Close Button */}
              <TouchableOpacity
                onPress={() => revealedMessage && handleBurnViewOnce(revealedMessage.id)}
                activeOpacity={0.8}
                style={{
                  backgroundColor: '#DC2626',
                  borderRadius: 8,
                  paddingVertical: 14,
                  alignItems: 'center',
                  flexDirection: 'row',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                <MaterialCommunityIcons name="fire" size={18} color="#FFFFFF" />
                <Text style={{
                  color: '#FFFFFF',
                  fontSize: 12,
                  fontWeight: '900',
                  letterSpacing: 1.5,
                  fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                }}>BURN & CLOSE</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
