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
  enqueueMessage,
  getQueuedMessages,
  deleteQueuedMessage
} from '@/db/database';
import { encryptMessage, decryptMessage, hashRoomKey } from '@/crypto/encryption';
import {
  startLiveSync,
  stopLiveSync,
  depositMessage,
  sendEmergencySignal,
  DeadDropEntry,
  DeadDropSignal,
  NetworkMessagePayload,
  PresenceMode,
} from '@/network/deadDrop';
import { setAppIcon } from '@howincodes/expo-dynamic-app-icon';

export default function ChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();

  // Params
  const callsign = (params.callsign as string) || 'UNKNOWN';
  const connectionKey = params.connectionKey as string;
  const isDuressAuth = params.isDuress === 'true';

  // Refs for callbacks
  const connectionKeyRef = useRef(connectionKey);
  const callsignRef = useRef(callsign);

  // State
  const [messages, setMessages] = useState<IMessage[]>([]);
  const [roomId, setRoomId] = useState<string>('');
  const [presenceMode, setPresenceMode] = useState<PresenceMode>('LONE');
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

  // Initialize SQLite database and 24-Hour Encrypted Dead Drop Live Sync
  useEffect(() => {
    let mounted = true;

    async function initChat() {
      if (!connectionKey) return;

      try {
        await initDatabase();

        const derivedRoomId = await hashRoomKey(connectionKey);
        setRoomId(derivedRoomId);

        // Load existing history if not a dream room
        if (!isDreamRoom) {
          const storedMessages = await fetchStoredMessages(derivedRoomId);
          if (mounted) setMessages(storedMessages);
        }

        console.log(`[DEAD-DROP][CLIENT] Starting Dead Drop engine for room=${derivedRoomId}`);

        // Start Live Synchronization & Asynchronous Dead Drop Pickup
        startLiveSync(derivedRoomId, callsign, {
          onMessage: async (drop: DeadDropEntry) => {
            console.log('[DEAD-DROP][CLIENT] Picked up encrypted message from dead drop:', drop.id);

            try {
              const decryptedText = await decryptMessage(drop.encrypted, connectionKeyRef.current);
              const msgId = drop.id || String(Date.now());
              const senderDisplayName = drop.senderCallsign || 'OPERATIVE';

              // Handle View Once messages — held in volatile RAM only
              if (drop.viewOnce) {
                viewOnceDataRef.current[msgId] = {
                  originalText: decryptedText,
                  senderCallsign: senderDisplayName,
                  isOwn: false,
                };

                const sealedMsg: IMessage = {
                  _id: msgId,
                  text: '🔒 CLASSIFIED INTEL',
                  createdAt: new Date(drop.createdAt),
                  user: { _id: 2, name: senderDisplayName },
                };
                if (mounted) setMessages((prev) => GiftedChat.append(prev, [sealedMsg]));
                return;
              }

              // Normal message
              const incomingMsg: IMessage = {
                _id: msgId,
                text: decryptedText,
                createdAt: new Date(drop.createdAt),
                user: { _id: 2, name: senderDisplayName },
              };

              if (mounted) setMessages((prev) => GiftedChat.append(prev, [incomingMsg]));

              if (!isDreamRoomRef.current) {
                await saveMessage(incomingMsg, derivedRoomId);
              }
            } catch (err) {
              console.error('[DEAD-DROP][CLIENT] Failed decrypting dead drop message:', err);
            }
          },

          onSignal: (signal: DeadDropSignal) => {
            if (signal.type === 'duress_signal') {
              console.warn('[DEAD-DROP][DURESS] Received emergency distress beacon from peer!');
              if (mounted) setDuressAlertReceived(true);
            } else if (signal.type === 'burn_notice') {
              console.log('[DEAD-DROP][BURN] Remote wipe signal received! Purging operative data...');
              (async () => {
                try {
                  await setAppIcon('calculator');
                } catch (e) {
                  console.error('Failed to set disguise app icon', e);
                }
                await setBurnedState(true);
                await clearAllMessages();
                if (mounted) {
                  setMessages([]);
                  router.replace('/decoy');
                }
              })();
            }
          },

          onPresenceChange: (presence: PresenceMode) => {
            if (mounted) setPresenceMode(presence);
          },
        });

        // If operative logged in under duress code, silently deposit distress signal to room
        if (isDuressAuth) {
          console.log('[DEAD-DROP][DURESS] Depositing silent distress signal to room...');
          await sendEmergencySignal(derivedRoomId, 'duress_signal', callsign);
        }

        // Send any queued offline messages
        const queued = await getQueuedMessages(derivedRoomId);
        if (queued.length > 0) {
          console.log(`[DEAD-DROP][CLIENT] Found ${queued.length} queued messages to deposit.`);
          for (const qMsg of queued) {
            try {
              const payload = JSON.parse(qMsg.payloadStr);
              const deposited = await depositMessage(derivedRoomId, payload);
              if (deposited) {
                await deleteQueuedMessage(qMsg.id);
              }
            } catch (err) {
              console.error('[DEAD-DROP] Failed depositing queued message', err);
            }
          }
        }
      } catch (err) {
        console.error('[DEAD-DROP][CLIENT] Failed initializing chat network:', err);
      }
    }

    initChat();

    return () => {
      mounted = false;
      stopLiveSync();
    };
  }, [callsign, connectionKey, isDuressAuth]);

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
          await saveMessage(placeholderMsg, roomId || (await hashRoomKey(connectionKey)));
        }
      } else {
        // Normal message flow
        setMessages((prev) => GiftedChat.append(prev, newMessages));

        if (!isDreamRoom) {
          await saveMessage(msgToSend, roomId || (await hashRoomKey(connectionKey)));
        }
      }

      // Encrypt the REAL text and deposit into the 24-hour Dead Drop
      try {
        const encrypted = await encryptMessage(msgToSend.text, connectionKey);
        const derivedRoomId = roomId || (await hashRoomKey(connectionKey));

        console.log(`[DEAD-DROP][CLIENT] Depositing encrypted payload to room ${derivedRoomId}...`);

        const networkPayload: NetworkMessagePayload = {
          id: msgId,
          roomId: derivedRoomId,
          senderCallsign: callsign,
          encrypted,
          createdAt: timestamp,
          viewOnce: sendingViewOnce || undefined,
          type: 'message',
        };

        const success = await depositMessage(derivedRoomId, networkPayload);
        if (!success) {
          console.log(`[DEAD-DROP][CLIENT] Direct deposit failed, saving to offline queue ${msgId}`);
          await enqueueMessage(derivedRoomId, msgId, JSON.stringify(networkPayload));
        }
      } catch (err) {
        console.error('[DEAD-DROP][CLIENT] Failed encrypting/depositing message:', err);
      }
    },
    [callsign, connectionKey, roomId, isDreamRoom, isViewOnce]
  );

  const handlePanicPress = async () => {
    try {
      const derivedRoomId = roomId || (await hashRoomKey(connectionKey));
      await sendEmergencySignal(derivedRoomId, 'burn_notice', callsign);
    } catch (err) {
      console.error('[DEAD-DROP][CLIENT] Failed sending burn notice:', err);
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
        behavior="padding"
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
                <View className={`w-2 h-2 rounded-full mr-1.5 ${
                  presenceMode === 'COM' ? 'bg-[#00FF66]' :
                  presenceMode === 'LONE' ? 'bg-[#F59E0B]' :
                  'bg-[#EF4444]'
                }`} />
                <Text
                  className={`text-[10px] font-bold tracking-widest ${
                    presenceMode === 'COM' ? 'text-[#00FF66]' :
                    presenceMode === 'LONE' ? 'text-[#F59E0B]' :
                    'text-[#EF4444]'
                  }`}
                  style={{ fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}
                >
                  {presenceMode}
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
                  const curRoomId = roomId || connectionKey; // Since roomId is derived async, we might not have it strictly synchronously here but it's set in state.
                  // Actually fetchStoredMessages is async
                  hashRoomKey(connectionKey).then(rId => fetchStoredMessages(rId).then(setMessages));
                } else {
                  // Entering Dream Room — clear view, go volatile
                  setIsDreamRoom(true);
                  viewOnceDataRef.current = {};
                  setMessages([]);
                }
              }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 6,
                borderWidth: 1,
                backgroundColor: isDreamRoom ? '#3B0764' : '#0F172A',
                borderColor: isDreamRoom ? '#C084FC' : '#334155',
              }}
            >
              <Ionicons
                name={isDreamRoom ? 'cloudy-night' : 'cloud-outline'}
                size={14}
                color={isDreamRoom ? '#C084FC' : '#94A3B8'}
              />
            </TouchableOpacity>

            {/* Burn Button */}
            <TouchableOpacity
              onPress={handlePanicPress}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 6,
                borderWidth: 1,
                backgroundColor: '#7F1D1D',
                borderColor: '#DC2626',
              }}
            >
              <Text className="text-white text-[9px] font-black tracking-widest">BURN</Text>
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
