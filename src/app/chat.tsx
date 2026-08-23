import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Modal,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  GiftedChat,
  IMessage,
  Bubble,
  BubbleProps,
  InputToolbar,
  InputToolbarProps,
  Send,
  SendProps,
} from 'react-native-gifted-chat';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import {
  initDatabase,
  fetchStoredMessages,
  saveMessage,
  clearAllMessages,
  setBurnedState,
  enqueueMessage,
  getQueuedMessages,
  deleteQueuedMessage,
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

interface ViewOnceRecord {
  originalText?: string;
  senderCallsign: string;
  isOwn: boolean;
  status: 'sealed' | 'revealed' | 'burnt' | 'sent' | 'opened_by_peer' | 'burned_by_peer';
}

export default function ChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();

  // Params
  const callsign = (params.callsign as string) || '';
  const connectionKey = params.connectionKey as string;
  const isDuressAuth = params.isDuress === 'true';

  // Refs for callbacks
  const connectionKeyRef = useRef(connectionKey);
  const callsignRef = useRef(callsign);

  // State
  const [messages, setMessages] = useState<IMessage[]>([]);
  const [roomId, setRoomId] = useState<string>('');
  const [presenceMode, setPresenceMode] = useState<PresenceMode>('LONE');
  const [duressAlertReceived, setDuressAlertReceived] = useState(false);

  // Tactical options
  const [isDreamRoom, setIsDreamRoom] = useState<boolean>(false);
  const [isViewOnce, setIsViewOnce] = useState(false);
  const [revealedMessage, setRevealedMessage] = useState<{
    id: string; text: string; sender: string;
  } | null>(null);

  // Mutual Dream Room Handshake state
  const [dreamInviteSent, setDreamInviteSent] = useState(false);
  const [incomingDreamInvite, setIncomingDreamInvite] = useState<{ requesterCallsign: string } | null>(null);
  const [bannerNotice, setBannerNotice] = useState<string | null>(null);

  // Keep refs for active configuration
  const isDreamRoomRef = useRef(isDreamRoom);
  isDreamRoomRef.current = isDreamRoom;
  const roomIdRef = useRef(roomId);
  roomIdRef.current = roomId;

  // View Once data store: msgId → ViewOnceRecord
  const viewOnceDataRef = useRef<Record<string, ViewOnceRecord>>({});

  // Auto-dismiss banner notices
  useEffect(() => {
    if (bannerNotice) {
      const t = setTimeout(() => setBannerNotice(null), 4000);
      return () => clearTimeout(t);
    }
  }, [bannerNotice]);

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
        roomIdRef.current = derivedRoomId;

        // Load existing history if not a dream room
        if (!isDreamRoomRef.current) {
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
                  status: 'sealed',
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
            console.log('[DEAD-DROP][SIGNAL] Received signal:', signal.type, signal.msgId);

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
            } else if (signal.type === 'letter_opened' && signal.msgId) {
              // Sender receives notification that recipient opened the letter
              if (viewOnceDataRef.current[signal.msgId]) {
                viewOnceDataRef.current[signal.msgId].status = 'opened_by_peer';
                if (mounted) setMessages((prev) => [...prev]);
              }
            } else if (signal.type === 'letter_burned' && signal.msgId) {
              // Sender receives notification that recipient burned the letter
              if (viewOnceDataRef.current[signal.msgId]) {
                viewOnceDataRef.current[signal.msgId].status = 'burned_by_peer';
                if (mounted) setMessages((prev) => [...prev]);
              }
            } else if (signal.type === 'dream_invite') {
              // Peer is requesting to enter Dream Room
              if (mounted) {
                setIncomingDreamInvite({ requesterCallsign: signal.senderCallsign || 'OPERATIVE' });
              }
            } else if (signal.type === 'dream_accept') {
              // Peer accepted our Dream Room request
              if (mounted) {
                setDreamInviteSent(false);
                setIsDreamRoom(true);
                setMessages([]);
                viewOnceDataRef.current = {};
                setBannerNotice('🌙 DREAM ROOM ACTIVATED (VOLATILE RAM)');
              }
            } else if (signal.type === 'dream_reject') {
              // Peer declined Dream Room
              if (mounted) {
                setDreamInviteSent(false);
                setBannerNotice('DREAM ROOM REQUEST DECLINED BY PEER');
              }
            } else if (signal.type === 'dream_terminate') {
              // Peer terminated Dream Room
              if (mounted && isDreamRoomRef.current) {
                setIsDreamRoom(false);
                viewOnceDataRef.current = {};
                setBannerNotice('DREAM ROOM TERMINATED BY PEER — RESTORING LOGS');
                hashRoomKey(connectionKey).then((rId) =>
                  fetchStoredMessages(rId).then((loaded) => mounted && setMessages(loaded))
                );
              }
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
  const handleRevealViewOnce = useCallback(
    async (msgId: string) => {
      const data = viewOnceDataRef.current[msgId];
      if (data && !data.isOwn && data.status === 'sealed' && data.originalText) {
        setRevealedMessage({ id: msgId, text: data.originalText, sender: data.senderCallsign });
        data.status = 'revealed';

        // Notify sender that the letter was opened
        const derivedRoomId = roomIdRef.current || (await hashRoomKey(connectionKeyRef.current));
        await sendEmergencySignal(derivedRoomId, 'letter_opened', callsignRef.current, msgId);
      }
    },
    []
  );

  const handleBurnViewOnce = useCallback(
    async (msgId: string) => {
      const data = viewOnceDataRef.current[msgId];
      if (data) {
        // Mark as burnt and wipe plaintext from volatile memory
        data.status = 'burnt';
        delete data.originalText;

        // Leave a visual "Burnt Letter" card in the message list
        setMessages((prev) =>
          prev.map((m) =>
            String(m._id) === msgId
              ? { ...m, text: '🔥 CLASSIFIED INTEL [DESTROYED]' }
              : m
          )
        );

        // Close modal
        setRevealedMessage(null);

        // Inform sender that the letter is burned
        const derivedRoomId = roomIdRef.current || (await hashRoomKey(connectionKeyRef.current));
        await sendEmergencySignal(derivedRoomId, 'letter_burned', callsignRef.current, msgId);
      }
    },
    []
  );

  // Dream Room Request Handlers
  const handleDreamRoomTogglePress = useCallback(async () => {
    if (presenceMode !== 'COM' && !isDreamRoom) {
      setBannerNotice('DREAM ROOM REQUIRES 2 OPERATIVES CONNECTED (COM MODE)');
      return;
    }

    const derivedRoomId = roomIdRef.current || (await hashRoomKey(connectionKeyRef.current));

    if (isDreamRoom) {
      // Terminate active dream room session
      setIsDreamRoom(false);
      viewOnceDataRef.current = {};
      setBannerNotice('DREAM ROOM TERMINATED — RESTORING LOGS');
      await sendEmergencySignal(derivedRoomId, 'dream_terminate', callsignRef.current);
      const stored = await fetchStoredMessages(derivedRoomId);
      setMessages(stored);
    } else {
      // Send invite to peer
      setDreamInviteSent(true);
      await sendEmergencySignal(derivedRoomId, 'dream_invite', callsignRef.current);
    }
  }, [presenceMode, isDreamRoom]);

  const handleAcceptDreamInvite = useCallback(async () => {
    const derivedRoomId = roomIdRef.current || (await hashRoomKey(connectionKeyRef.current));
    setIncomingDreamInvite(null);
    setIsDreamRoom(true);
    setMessages([]);
    viewOnceDataRef.current = {};
    setBannerNotice('🌙 DREAM ROOM ACTIVATED (VOLATILE RAM)');
    await sendEmergencySignal(derivedRoomId, 'dream_accept', callsignRef.current);
  }, []);

  const handleDeclineDreamInvite = useCallback(async () => {
    const derivedRoomId = roomIdRef.current || (await hashRoomKey(connectionKeyRef.current));
    setIncomingDreamInvite(null);
    await sendEmergencySignal(derivedRoomId, 'dream_reject', callsignRef.current);
  }, []);

  const handleCancelDreamInvite = useCallback(async () => {
    const derivedRoomId = roomIdRef.current || (await hashRoomKey(connectionKeyRef.current));
    setDreamInviteSent(false);
    await sendEmergencySignal(derivedRoomId, 'dream_reject', callsignRef.current);
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
          senderCallsign: callsign,
          isOwn: true,
          status: 'sent',
        };

        // Append placeholder to local UI
        const placeholderMsg: IMessage = {
          ...msgToSend,
          text: '📨 ONE-TIME LETTER SENT',
        };
        setMessages((prev) => GiftedChat.append(prev, [placeholderMsg]));

        // Persist placeholder to SQLite if not in Dream Room
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

    // 1. Recipient side view-once
    if (viewOnceInfo && !viewOnceInfo.isOwn) {
      // Burnt letter artifact left behind
      if (viewOnceInfo.status === 'burnt') {
        return (
          <View style={{ marginBottom: 8, marginLeft: 8, maxWidth: '80%' }}>
            <View
              style={{
                backgroundColor: '#0F0F12',
                borderWidth: 1.5,
                borderColor: '#7F1D1D',
                borderRadius: 12,
                padding: 14,
                alignItems: 'center',
                gap: 4,
              }}
            >
              <MaterialCommunityIcons name="fire-off" size={20} color="#EF4444" />
              <Text
                style={{
                  color: '#EF4444',
                  fontSize: 10,
                  fontWeight: '900',
                  letterSpacing: 1.5,
                  fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                }}
              >
                🔥 CLASSIFIED INTEL [DESTROYED]
              </Text>
              <Text
                style={{
                  color: '#71717A',
                  fontSize: 8,
                  fontWeight: '700',
                  letterSpacing: 1,
                  fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                }}
              >
                BURNT LETTER — PERMANENTLY ERASED
              </Text>
            </View>
          </View>
        );
      }

      // Sealed letter card (tap to reveal)
      return (
        <TouchableOpacity
          onPress={() => handleRevealViewOnce(msgId)}
          activeOpacity={0.7}
          style={{ marginBottom: 8, marginLeft: 8, maxWidth: '75%' }}
        >
          <View
            style={{
              backgroundColor: '#1A0A2E',
              borderWidth: 1.5,
              borderColor: '#F59E0B',
              borderStyle: 'dashed',
              borderRadius: 12,
              padding: 16,
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Ionicons name="lock-closed" size={24} color="#F59E0B" />
            <Text
              style={{
                color: '#F59E0B',
                fontSize: 11,
                fontWeight: '900',
                letterSpacing: 2,
                fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
              }}
            >
              CLASSIFIED INTEL
            </Text>
            <Text
              style={{
                color: '#D97706',
                fontSize: 9,
                fontWeight: '700',
                letterSpacing: 1,
                fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
              }}
            >
              TAP TO REVEAL
            </Text>
          </View>
        </TouchableOpacity>
      );
    }

    // 2. Sender side view-once status cards
    if (viewOnceInfo && viewOnceInfo.isOwn) {
      if (viewOnceInfo.status === 'burned_by_peer') {
        return (
          <View style={{ marginBottom: 8, marginRight: 8, maxWidth: '80%' }}>
            <View
              style={{
                backgroundColor: '#1C1917',
                borderWidth: 1,
                borderColor: '#DC2626',
                borderRadius: 12,
                padding: 12,
                alignItems: 'center',
                gap: 6,
                flexDirection: 'row',
              }}
            >
              <MaterialCommunityIcons name="fire" size={18} color="#EF4444" />
              <View>
                <Text
                  style={{
                    color: '#EF4444',
                    fontSize: 10,
                    fontWeight: '900',
                    letterSpacing: 1.5,
                    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                  }}
                >
                  🔥 ONE-TIME LETTER DESTROYED
                </Text>
                <Text
                  style={{
                    color: '#78716C',
                    fontSize: 8,
                    fontWeight: '700',
                    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                  }}
                >
                  RECIPIENT BURNED PAYLOAD
                </Text>
              </View>
            </View>
          </View>
        );
      }

      if (viewOnceInfo.status === 'opened_by_peer') {
        return (
          <View style={{ marginBottom: 8, marginRight: 8, maxWidth: '80%' }}>
            <View
              style={{
                backgroundColor: '#1C1917',
                borderWidth: 1,
                borderColor: '#F59E0B',
                borderRadius: 12,
                padding: 12,
                alignItems: 'center',
                gap: 6,
                flexDirection: 'row',
              }}
            >
              <Ionicons name="eye-outline" size={18} color="#F59E0B" />
              <View>
                <Text
                  style={{
                    color: '#F59E0B',
                    fontSize: 10,
                    fontWeight: '900',
                    letterSpacing: 1.5,
                    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                  }}
                >
                  👁️ ONE-TIME LETTER OPENED
                </Text>
                <Text
                  style={{
                    color: '#78716C',
                    fontSize: 8,
                    fontWeight: '700',
                    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                  }}
                >
                  RECIPIENT IS READING
                </Text>
              </View>
            </View>
          </View>
        );
      }

      // Default sent state
      return (
        <View style={{ marginBottom: 8, marginRight: 8, maxWidth: '75%' }}>
          <View
            style={{
              backgroundColor: '#1C1917',
              borderWidth: 1,
              borderColor: '#78716C',
              borderRadius: 12,
              padding: 14,
              alignItems: 'center',
              gap: 4,
              flexDirection: 'row',
            }}
          >
            <Ionicons name="mail-outline" size={18} color="#A8A29E" />
            <Text
              style={{
                color: '#A8A29E',
                fontSize: 10,
                fontWeight: '800',
                letterSpacing: 1.5,
                marginLeft: 6,
                fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
              }}
            >
              ONE-TIME LETTER SENT
            </Text>
          </View>
        </View>
      );
    }

    // 3. Normal message bubble
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
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: isViewOnce ? '#F59E0B' : isDreamRoom ? '#C084FC' : '#00F0FF',
          }}
        >
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

  const isDreamButtonDisabled = presenceMode !== 'COM' && !isDreamRoom;

  return (
    <SafeAreaView
      className={`flex-1 ${isDreamRoom ? 'bg-[#581C87]' : 'bg-tactical-bg'}`}
      edges={['top', 'bottom', 'left', 'right']}
    >
      <KeyboardAvoidingView behavior="padding" className="flex-1">
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
                <View
                  className={`w-2 h-2 rounded-full mr-1.5 ${
                    presenceMode === 'COM'
                      ? 'bg-[#00FF66]'
                      : presenceMode === 'LONE'
                      ? 'bg-[#F59E0B]'
                      : 'bg-[#EF4444]'
                  }`}
                />
                <Text
                  className={`text-[10px] font-bold tracking-widest ${
                    presenceMode === 'COM'
                      ? 'text-[#00FF66]'
                      : presenceMode === 'LONE'
                      ? 'text-[#F59E0B]'
                      : 'text-[#EF4444]'
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
                <Text
                  style={{
                    color: '#F59E0B',
                    fontSize: 9,
                    fontWeight: '800',
                    marginLeft: 4,
                    letterSpacing: 0.5,
                    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                  }}
                >
                  1x
                </Text>
              )}
            </TouchableOpacity>

            {/* Dream Room Toggle with COM Mode Guard */}
            <TouchableOpacity
              onPress={handleDreamRoomTogglePress}
              activeOpacity={isDreamButtonDisabled ? 1 : 0.7}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 6,
                borderWidth: 1,
                backgroundColor: isDreamRoom
                  ? '#3B0764'
                  : isDreamButtonDisabled
                  ? '#0B0F19'
                  : '#0F172A',
                borderColor: isDreamRoom
                  ? '#C084FC'
                  : isDreamButtonDisabled
                  ? '#1E293B'
                  : '#334155',
                opacity: isDreamButtonDisabled ? 0.4 : 1,
              }}
            >
              <Ionicons
                name={
                  isDreamRoom
                    ? 'cloudy-night'
                    : isDreamButtonDisabled
                    ? 'lock-closed'
                    : 'cloud-outline'
                }
                size={14}
                color={
                  isDreamRoom
                    ? '#C084FC'
                    : isDreamButtonDisabled
                    ? '#475569'
                    : '#94A3B8'
                }
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

        {/* Tactical Banner Notice */}
        {bannerNotice && (
          <View className="bg-[#1E1B4B] py-2 px-4 border-b border-[#6366F1] flex-row items-center justify-center gap-2">
            <Ionicons name="information-circle" size={14} color="#818CF8" />
            <Text
              className="text-[#818CF8] text-[9px] font-black tracking-widest text-center"
              style={{ fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}
            >
              {bannerNotice}
            </Text>
          </View>
        )}

        {duressAlertReceived && (
          <View className="bg-[#450A0A] py-2 px-4 border-b border-tactical-red flex-row items-center justify-center gap-2">
            <MaterialCommunityIcons name="shield-alert" size={16} color="#EF4444" />
            <Text
              className="text-tactical-red text-[10px] font-black tracking-widest text-center"
              style={{ fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}
            >
              DISTRESS SIGNAL RECEIVED FROM PEER
            </Text>
          </View>
        )}

        {/* View Once active indicator banner */}
        {isViewOnce && (
          <View
            style={{
              backgroundColor: '#451A03',
              borderBottomWidth: 1,
              borderBottomColor: '#F59E0B',
              paddingVertical: 6,
              paddingHorizontal: 16,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}
          >
            <Ionicons name="mail" size={12} color="#F59E0B" />
            <Text
              style={{
                color: '#F59E0B',
                fontSize: 9,
                fontWeight: '900',
                letterSpacing: 1.5,
                fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
              }}
            >
              VIEW ONCE — NEXT MESSAGE IS A ONE-TIME LETTER
            </Text>
          </View>
        )}

        <View className="flex-1 px-1">
          <GiftedChat
            messages={messages}
            onSend={(newMessages) => onSend(newMessages)}
            user={{ _id: 1, name: callsign || 'ME' }}
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
          <View
            style={{
              flex: 1,
              backgroundColor: 'rgba(0,0,0,0.85)',
              justifyContent: 'center',
              alignItems: 'center',
              padding: 24,
            }}
          >
            <View
              style={{
                backgroundColor: '#0F172A',
                borderWidth: 1.5,
                borderColor: '#F59E0B',
                borderRadius: 16,
                padding: 24,
                width: '100%',
                maxWidth: 360,
                gap: 16,
              }}
            >
              {/* Modal Header */}
              <View style={{ alignItems: 'center', gap: 8 }}>
                <Ionicons name="lock-open" size={28} color="#F59E0B" />
                <Text
                  style={{
                    color: '#F59E0B',
                    fontSize: 11,
                    fontWeight: '900',
                    letterSpacing: 2,
                    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                  }}
                >
                  CLASSIFIED INTEL
                </Text>
                <Text
                  style={{
                    color: '#94A3B8',
                    fontSize: 9,
                    fontWeight: '700',
                    letterSpacing: 1,
                    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                  }}
                >
                  FROM: {revealedMessage?.sender || 'OPERATIVE'}
                </Text>
              </View>

              {/* Decrypted Message Content */}
              <View
                style={{
                  backgroundColor: '#1E293B',
                  borderRadius: 8,
                  padding: 16,
                  borderWidth: 1,
                  borderColor: '#334155',
                }}
              >
                <Text
                  style={{
                    color: '#F8FAFC',
                    fontSize: 16,
                    lineHeight: 24,
                    fontWeight: '500',
                  }}
                >
                  {revealedMessage?.text}
                </Text>
              </View>

              {/* Destruction Warning */}
              <Text
                style={{
                  color: '#EF4444',
                  fontSize: 8,
                  fontWeight: '800',
                  letterSpacing: 1,
                  textAlign: 'center',
                  fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                }}
              >
                ⚠ THIS MESSAGE WILL BE DESTROYED ON CLOSE
              </Text>

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
                <Text
                  style={{
                    color: '#FFFFFF',
                    fontSize: 12,
                    fontWeight: '900',
                    letterSpacing: 1.5,
                    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                  }}
                >
                  BURN & CLOSE
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* Outgoing Dream Room Invite Waiting Modal */}
        <Modal visible={dreamInviteSent} transparent animationType="fade">
          <View
            style={{
              flex: 1,
              backgroundColor: 'rgba(0,0,0,0.85)',
              justifyContent: 'center',
              alignItems: 'center',
              padding: 24,
            }}
          >
            <View
              style={{
                backgroundColor: '#1E1B4B',
                borderWidth: 1.5,
                borderColor: '#C084FC',
                borderRadius: 16,
                padding: 24,
                width: '100%',
                maxWidth: 360,
                alignItems: 'center',
                gap: 16,
              }}
            >
              <Ionicons name="cloudy-night" size={36} color="#C084FC" />
              <Text
                style={{
                  color: '#C084FC',
                  fontSize: 13,
                  fontWeight: '900',
                  letterSpacing: 2,
                  fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                }}
              >
                DREAM ROOM ACCESS
              </Text>
              <ActivityIndicator size="small" color="#C084FC" />
              <Text
                style={{
                  color: '#E2E8F0',
                  fontSize: 11,
                  textAlign: 'center',
                  lineHeight: 18,
                  fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                }}
              >
                AWAITING OPERATIVE CONFIRMATION...
              </Text>
              <TouchableOpacity
                onPress={handleCancelDreamInvite}
                style={{
                  backgroundColor: '#374151',
                  borderRadius: 8,
                  paddingVertical: 10,
                  paddingHorizontal: 20,
                  marginTop: 8,
                }}
              >
                <Text className="text-white text-[10px] font-bold tracking-widest">CANCEL</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* Incoming Dream Room Confirmation Prompt */}
        <Modal visible={incomingDreamInvite !== null} transparent animationType="fade">
          <View
            style={{
              flex: 1,
              backgroundColor: 'rgba(0,0,0,0.85)',
              justifyContent: 'center',
              alignItems: 'center',
              padding: 24,
            }}
          >
            <View
              style={{
                backgroundColor: '#1E1B4B',
                borderWidth: 1.5,
                borderColor: '#C084FC',
                borderRadius: 16,
                padding: 24,
                width: '100%',
                maxWidth: 360,
                alignItems: 'center',
                gap: 14,
              }}
            >
              <Ionicons name="cloudy-night" size={36} color="#C084FC" />
              <Text
                style={{
                  color: '#C084FC',
                  fontSize: 13,
                  fontWeight: '900',
                  letterSpacing: 2,
                  fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                }}
              >
                DREAM ROOM INVITATION
              </Text>
              <Text
                style={{
                  color: '#E2E8F0',
                  fontSize: 11,
                  textAlign: 'center',
                  lineHeight: 18,
                  fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                }}
              >
                Operative {incomingDreamInvite?.requesterCallsign || 'PEER'} requests entry into
                Dream Room.{'\n\n'}
                Volatile RAM session only. SQLite storage will be paused and wiped on session exit.
              </Text>

              <View style={{ flexDirection: 'row', gap: 12, marginTop: 8, width: '100%' }}>
                <TouchableOpacity
                  onPress={handleDeclineDreamInvite}
                  style={{
                    flex: 1,
                    backgroundColor: '#374151',
                    borderRadius: 8,
                    paddingVertical: 12,
                    alignItems: 'center',
                  }}
                >
                  <Text className="text-white text-[10px] font-black tracking-widest">DECLINE</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={handleAcceptDreamInvite}
                  style={{
                    flex: 1,
                    backgroundColor: '#7E22CE',
                    borderRadius: 8,
                    paddingVertical: 12,
                    alignItems: 'center',
                  }}
                >
                  <Text className="text-white text-[10px] font-black tracking-widest">ACCEPT</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
