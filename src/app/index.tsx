import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { initDatabase, getBurnedState } from '@/db/database';

export default function PairingScreen() {
  const router = useRouter();
  const [connectionKey, setConnectionKey] = useState('');
  const [callsign, setCallsign] = useState('OPERATOR-ALPHA');
  const [serverUrl, setServerUrl] = useState('https://spycom-relay.onrender.com');
  const [showKey, setShowKey] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    async function checkBurnStatus() {
      await initDatabase();
      const isBurned = await getBurnedState();
      if (isBurned) {
        router.replace('/decoy');
      }
    }
    checkBurnStatus();
  }, [router]);

  const handleConnect = () => {
    if (!connectionKey.trim()) {
      setErrorMsg('CRITICAL ERROR: Connection key cannot be empty');
      return;
    }

    const isDuressAuth = connectionKey.trim() === 'PANIC123';

    setErrorMsg('');

    router.push({
      pathname: '/chat',
      params: {
        callsign: callsign.trim() || 'OPERATOR-ALPHA',
        connectionKey: connectionKey.trim(),
        serverUrl: serverUrl.trim() || 'http://localhost:3000',
        isDuress: isDuressAuth ? 'true' : 'false',
      },
    });
  };

  return (
    <SafeAreaView className="flex-1 bg-tactical-bg" edges={['top', 'bottom', 'left', 'right']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1 px-5 py-3 justify-between"
      >
        {/* Top Telemetry Header */}
        <View className="flex-row justify-between bg-tactical-card py-2 px-3 rounded-md border border-tactical-border">
          <View className="flex-row items-center gap-1.5">
            <View className="w-2 h-2 rounded-full bg-tactical-green" />
            <Text className="text-tactical-textMuted text-[10px] font-bold tracking-widest" style={{ fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}>SIGNAL: READY</Text>
          </View>
          <View className="flex-row items-center gap-1.5">
            <MaterialCommunityIcons name="radio-tower" size={14} color="#00F0FF" />
            <Text className="text-tactical-textMuted text-[10px] font-bold tracking-widest" style={{ fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}>RELAY ACTIVE</Text>
          </View>
          <View className="flex-row items-center gap-1.5">
            <MaterialCommunityIcons name="chip" size={14} color="#00FF66" />
            <Text className="text-tactical-textMuted text-[10px] font-bold tracking-widest" style={{ fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}>E2EE AES-256</Text>
          </View>
        </View>

        {/* Tactical Title Section */}
        <View className="items-center my-3">
          <View className="w-[70px] h-[70px] rounded-full bg-tactical-card border-2 border-tactical-cyan justify-center items-center mb-3 relative">
            <Ionicons name="shield-checkmark-outline" size={44} color="#00F0FF" />
            <View className="absolute bottom-0.5 right-0.5 bg-tactical-cyan rounded-[10px] p-[3px]">
              <Ionicons name="lock-closed" size={14} color="#080C14" />
            </View>
          </View>
          <Text className="text-tactical-text text-[22px] font-black tracking-[3px]">TACTICAL E2EE</Text>
          <Text className="text-tactical-textDim text-[10px] font-bold tracking-[1.5px] mt-1">PAIRING & AUTHENTICATION PROTOCOL</Text>
          <View className="flex-row items-center gap-1.5 bg-[#052E16] border border-tactical-green px-2.5 py-1 rounded-xl mt-2.5">
            <MaterialCommunityIcons name="console" size={12} color="#00FF66" />
            <Text className="text-tactical-green text-[10px] font-extrabold tracking-widest" style={{ fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}>COMM-LINK // HIGH PRIVACY MODE</Text>
          </View>
        </View>

        {/* Main Form Card with Tactical Framing */}
        <View className="bg-tactical-card rounded-lg p-[18px] border border-tactical-border relative">
          <View className="absolute w-2.5 h-2.5 border-tactical-cyan -top-[1px] -left-[1px] border-t-2 border-l-2" />
          <View className="absolute w-2.5 h-2.5 border-tactical-cyan -top-[1px] -right-[1px] border-t-2 border-r-2" />
          <View className="absolute w-2.5 h-2.5 border-tactical-cyan -bottom-[1px] -left-[1px] border-b-2 border-l-2" />
          <View className="absolute w-2.5 h-2.5 border-tactical-cyan -bottom-[1px] -right-[1px] border-b-2 border-r-2" />

          <Text className="text-tactical-cyan text-[11px] font-extrabold tracking-[2px] mb-3.5 text-center" style={{ fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}>SECURITY CLEARANCE</Text>

          {/* Callsign Input */}
          <View className="mb-3">
            <Text className="text-tactical-textMuted text-[9px] font-bold tracking-[1px] mb-1" style={{ fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}>YOUR CALLSIGN</Text>
            <View className="flex-row items-center bg-tactical-bg border border-tactical-borderLight rounded-md px-3 h-11">
              <MaterialCommunityIcons name="console" size={18} color="#64748B" className="mr-2.5" />
              <TextInput
                className="flex-1 text-tactical-text text-[13px] font-semibold"
                value={callsign}
                onChangeText={setCallsign}
                placeholder="OPERATOR-ALPHA"
                placeholderTextColor="#475569"
                autoCapitalize="characters"
                maxLength={16}
              />
            </View>
          </View>

          {/* Shared Connection Key Input */}
          <View className="mb-3">
            <Text className="text-tactical-textMuted text-[9px] font-bold tracking-[1px] mb-1" style={{ fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}>SHARED CONNECTION KEY (PASSWORD)</Text>
            <View className="flex-row items-center bg-tactical-bg border border-tactical-borderLight rounded-md px-3 h-11">
              <Ionicons name="key-outline" size={18} color="#00F0FF" className="mr-2.5" />
              <TextInput
                className="flex-1 text-tactical-text text-[13px] font-semibold"
                value={connectionKey}
                onChangeText={(text) => {
                  setConnectionKey(text);
                  if (errorMsg) setErrorMsg('');
                }}
                placeholder="Enter pre-shared key..."
                placeholderTextColor="#475569"
                secureTextEntry={!showKey}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                onPress={() => setShowKey(!showKey)}
                className="p-1.5"
                activeOpacity={0.7}
              >
                {showKey ? (
                  <Ionicons name="eye-off-outline" size={18} color="#00F0FF" />
                ) : (
                  <Ionicons name="eye-outline" size={18} color="#64748B" />
                )}
              </TouchableOpacity>
            </View>
          </View>




          {/* Relay Server Endpoint */}
          <View className="mb-3">
            <Text className="text-tactical-textMuted text-[9px] font-bold tracking-[1px] mb-1" style={{ fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}>RELAY SERVER ENDPOINT</Text>
            <View className="flex-row items-center bg-tactical-bg border border-tactical-borderLight rounded-md px-3 h-11">
              <MaterialCommunityIcons name="server-network" size={18} color="#00FF66" className="mr-2.5" />
              <TextInput
                className="flex-1 text-tactical-text text-[13px] font-semibold"
                value={serverUrl}
                onChangeText={setServerUrl}
                placeholder="http://localhost:3000"
                placeholderTextColor="#475569"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          </View>

          {/* Error Notice */}
          {errorMsg ? (
            <View className="bg-[#450A0A] border border-tactical-red p-2.5 rounded-md mb-3">
              <Text className="text-[#FCA5A5] text-[11px] font-bold text-center tracking-widest" style={{ fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}>{errorMsg}</Text>
            </View>
          ) : null}

          {/* Submit Button */}
          <TouchableOpacity
            className="bg-tactical-cyan rounded-md h-[46px] justify-center items-center mt-1.5 shadow-md shadow-tactical-cyan/50"
            style={{ elevation: 4 }}
            onPress={handleConnect}
            activeOpacity={0.8}
          >
            <View className="flex-row items-center">
              <Ionicons name="shield-checkmark" size={20} color="#080C14" style={{ marginRight: 8 }} />
              <Text className="text-[#080C14] text-xs font-black tracking-[1.5px]" style={{ fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}>
                ESTABLISH SECURE LINK
              </Text>
            </View>
          </TouchableOpacity>
        </View>

        {/* Footer Info */}
        <View className="items-center py-2">
          <Text className="text-tactical-textDark text-[9px] font-bold tracking-[1px]" style={{ fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}>AES-256-GCM E2EE // STATELESS RELAY SERVER</Text>
          <Text className="text-tactical-borderLight text-[8px] mt-0.5" style={{ fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}>TACTICAL MESH NETWORK v1.0.0</Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
