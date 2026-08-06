import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import '@/global.css';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View className="flex-1 bg-[#020617] items-center justify-center">
        <View 
          className="flex-1 w-full bg-tactical-bg"
          style={{ maxWidth: Platform.OS === 'web' ? 480 : undefined }}
        >
          <Stack
            screenOptions={{
              headerShown: false,
              animation: 'fade',
              contentStyle: { backgroundColor: '#080C14' },
            }}
          >
            <Stack.Screen name="index" options={{ title: 'Pairing' }} />
            <Stack.Screen name="chat" options={{ title: 'Tactical Chat' }} />
            <Stack.Screen name="decoy" options={{ title: 'Calculator' }} />
          </Stack>
        </View>
      </View>
    </SafeAreaProvider>
  );
}
