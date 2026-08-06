import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { setBurnedState } from '@/db/database';

export default function DecoyCalculatorScreen() {
  const router = useRouter();
  const { width: windowWidth } = useWindowDimensions();

  // Cap effective layout width to 440px so it renders beautifully on desktop web as well as mobile
  const effectiveWidth = Math.min(windowWidth, 440);
  const paddingHorizontal = 16;
  const gap = 12;
  const buttonSize = Math.max(50, Math.floor((effectiveWidth - paddingHorizontal * 2 - gap * 3) / 4));

  const [displayValue, setDisplayValue] = useState('0');
  const [expression, setExpression] = useState('');
  const [prevValue, setPrevValue] = useState<number | null>(null);
  const [operator, setOperator] = useState<string | null>(null);
  const [waitingForOperand, setWaitingForOperand] = useState(false);

  // Keypress history tracking for secret trigger "6 * 9 ="
  const [keySequence, setKeySequence] = useState<string[]>([]);

  // Function to process keypress and check for secret sequence
  const handleTap = (type: string, value: string) => {
    // Append to secret tracking array
    const updatedSequence = [...keySequence, value].slice(-10); // Keep last 10 keypresses
    setKeySequence(updatedSequence);

    // Check secret unlock trigger: "6", "*", "9", "="
    const lastFour = updatedSequence.slice(-4).join('');
    if (lastFour === '6*9=' || lastFour === '6×9=') {
      // Clear burned status in database
      setBurnedState(false);
      // Trigger secret unlock back to Pairing Screen
      setTimeout(() => {
        router.replace('/');
      }, 150);
      return;
    }


    if (type === 'number') {
      if (waitingForOperand) {
        setDisplayValue(value);
        setWaitingForOperand(false);
      } else {
        setDisplayValue(displayValue === '0' ? value : displayValue + value);
      }
    }

    if (type === 'operator') {
      const inputValue = parseFloat(displayValue);

      if (prevValue == null) {
        setPrevValue(inputValue);
      } else if (operator) {
        const currentValue = prevValue || 0;
        const newValue = calculate(currentValue, inputValue, operator);
        setPrevValue(newValue);
        setDisplayValue(String(newValue));
      }

      setWaitingForOperand(true);
      setOperator(value);
      setExpression(`${displayValue} ${value}`);
    }

    if (type === 'equal') {
      const inputValue = parseFloat(displayValue);

      if (operator && prevValue != null) {
        const result = calculate(prevValue, inputValue, operator);
        setExpression(`${prevValue} ${operator} ${inputValue} =`);
        setDisplayValue(String(result));
        setPrevValue(null);
        setOperator(null);
        setWaitingForOperand(true);
      }
    }

    if (type === 'clear') {
      setDisplayValue('0');
      setExpression('');
      setPrevValue(null);
      setOperator(null);
      setWaitingForOperand(false);
    }

    if (type === 'posneg') {
      const valueNum = parseFloat(displayValue);
      setDisplayValue(String(valueNum * -1));
    }

    if (type === 'percentage') {
      const valueNum = parseFloat(displayValue);
      setDisplayValue(String(valueNum / 100));
    }

    if (type === 'decimal') {
      if (!displayValue.includes('.')) {
        setDisplayValue(displayValue + '.');
        setWaitingForOperand(false);
      }
    }
  };

  const calculate = (firstOperand: number, secondOperand: number, op: string) => {
    switch (op) {
      case '+':
        return firstOperand + secondOperand;
      case '-':
        return firstOperand - secondOperand;
      case '*':
      case '×':
        return firstOperand * secondOperand;
      case '/':
      case '÷':
        return secondOperand !== 0 ? firstOperand / secondOperand : 0;
      default:
        return secondOperand;
    }
  };

  const dynamicButtonStyle = {
    width: buttonSize,
    height: buttonSize,
    borderRadius: buttonSize / 2,
  };

  const dynamicZeroStyle = {
    width: buttonSize * 2 + gap,
    height: buttonSize,
    borderRadius: buttonSize / 2,
  };

  return (
    <SafeAreaView className="flex-1 bg-black items-center justify-center" edges={['top', 'bottom', 'left', 'right']}>
      <View className="flex-1 w-full justify-end" style={{ maxWidth: 440, paddingBottom: Platform.OS === 'android' ? 24 : 16 }}>
        {/* Calculator Display Screen */}
        <View className="flex-1 justify-end items-end px-6 pb-5">
          <Text className="text-[#A1A1AA] text-xl font-normal mb-2">{expression}</Text>
          <Text className="text-white text-[56px] font-light" numberOfLines={1} adjustsFontSizeToFit>
            {displayValue}
          </Text>
        </View>

        {/* Calculator Keypad Grid */}
        <View className="w-full" style={{ paddingHorizontal, gap }}>
          {/* Row 1 */}
          <View className="flex-row justify-between mb-3" style={{ gap }}>
            <TouchableOpacity
              className="justify-center items-center bg-[#A1A1AA]"
              style={dynamicButtonStyle}
              onPress={() => handleTap('clear', 'C')}
              activeOpacity={0.7}
            >
              <Text className="text-black text-2xl font-medium">C</Text>
            </TouchableOpacity>
            <TouchableOpacity
              className="justify-center items-center bg-[#A1A1AA]"
              style={dynamicButtonStyle}
              onPress={() => handleTap('posneg', '+/-')}
              activeOpacity={0.7}
            >
              <Text className="text-black text-2xl font-medium">+/-</Text>
            </TouchableOpacity>
            <TouchableOpacity
              className="justify-center items-center bg-[#A1A1AA]"
              style={dynamicButtonStyle}
              onPress={() => handleTap('percentage', '%')}
              activeOpacity={0.7}
            >
              <Text className="text-black text-2xl font-medium">%</Text>
            </TouchableOpacity>
            <TouchableOpacity
              className="justify-center items-center bg-[#F97316]"
              style={dynamicButtonStyle}
              onPress={() => handleTap('operator', '÷')}
              activeOpacity={0.7}
            >
              <Text className="text-white text-3xl font-normal">÷</Text>
            </TouchableOpacity>
          </View>

          {/* Row 2 */}
          <View className="flex-row justify-between mb-3" style={{ gap }}>
            <TouchableOpacity
              className="justify-center items-center bg-[#27272A]"
              style={dynamicButtonStyle}
              onPress={() => handleTap('number', '7')}
              activeOpacity={0.7}
            >
              <Text className="text-white text-3xl font-normal">7</Text>
            </TouchableOpacity>
            <TouchableOpacity
              className="justify-center items-center bg-[#27272A]"
              style={dynamicButtonStyle}
              onPress={() => handleTap('number', '8')}
              activeOpacity={0.7}
            >
              <Text className="text-white text-3xl font-normal">8</Text>
            </TouchableOpacity>
            <TouchableOpacity
              className="justify-center items-center bg-[#27272A]"
              style={dynamicButtonStyle}
              onPress={() => handleTap('number', '9')}
              activeOpacity={0.7}
            >
              <Text className="text-white text-3xl font-normal">9</Text>
            </TouchableOpacity>
            <TouchableOpacity
              className="justify-center items-center bg-[#F97316]"
              style={dynamicButtonStyle}
              onPress={() => handleTap('operator', '*')}
              activeOpacity={0.7}
            >
              <Text className="text-white text-3xl font-normal">×</Text>
            </TouchableOpacity>
          </View>

          {/* Row 3 */}
          <View className="flex-row justify-between mb-3" style={{ gap }}>
            <TouchableOpacity
              className="justify-center items-center bg-[#27272A]"
              style={dynamicButtonStyle}
              onPress={() => handleTap('number', '4')}
              activeOpacity={0.7}
            >
              <Text className="text-white text-3xl font-normal">4</Text>
            </TouchableOpacity>
            <TouchableOpacity
              className="justify-center items-center bg-[#27272A]"
              style={dynamicButtonStyle}
              onPress={() => handleTap('number', '5')}
              activeOpacity={0.7}
            >
              <Text className="text-white text-3xl font-normal">5</Text>
            </TouchableOpacity>
            <TouchableOpacity
              className="justify-center items-center bg-[#27272A]"
              style={dynamicButtonStyle}
              onPress={() => handleTap('number', '6')}
              activeOpacity={0.7}
            >
              <Text className="text-white text-3xl font-normal">6</Text>
            </TouchableOpacity>
            <TouchableOpacity
              className="justify-center items-center bg-[#F97316]"
              style={dynamicButtonStyle}
              onPress={() => handleTap('operator', '-')}
              activeOpacity={0.7}
            >
              <Text className="text-white text-3xl font-normal">−</Text>
            </TouchableOpacity>
          </View>

          {/* Row 4 */}
          <View className="flex-row justify-between mb-3" style={{ gap }}>
            <TouchableOpacity
              className="justify-center items-center bg-[#27272A]"
              style={dynamicButtonStyle}
              onPress={() => handleTap('number', '1')}
              activeOpacity={0.7}
            >
              <Text className="text-white text-3xl font-normal">1</Text>
            </TouchableOpacity>
            <TouchableOpacity
              className="justify-center items-center bg-[#27272A]"
              style={dynamicButtonStyle}
              onPress={() => handleTap('number', '2')}
              activeOpacity={0.7}
            >
              <Text className="text-white text-3xl font-normal">2</Text>
            </TouchableOpacity>
            <TouchableOpacity
              className="justify-center items-center bg-[#27272A]"
              style={dynamicButtonStyle}
              onPress={() => handleTap('number', '3')}
              activeOpacity={0.7}
            >
              <Text className="text-white text-3xl font-normal">3</Text>
            </TouchableOpacity>
            <TouchableOpacity
              className="justify-center items-center bg-[#F97316]"
              style={dynamicButtonStyle}
              onPress={() => handleTap('operator', '+')}
              activeOpacity={0.7}
            >
              <Text className="text-white text-3xl font-normal">+</Text>
            </TouchableOpacity>
          </View>

          {/* Row 5 */}
          <View className="flex-row justify-between mb-3" style={{ gap }}>
            <TouchableOpacity
              className="justify-center items-start bg-[#27272A]"
              style={dynamicZeroStyle}
              onPress={() => handleTap('number', '0')}
              activeOpacity={0.7}
            >
              <Text className="text-white text-3xl font-normal pl-6">0</Text>
            </TouchableOpacity>
            <TouchableOpacity
              className="justify-center items-center bg-[#27272A]"
              style={dynamicButtonStyle}
              onPress={() => handleTap('decimal', '.')}
              activeOpacity={0.7}
            >
              <Text className="text-white text-3xl font-normal">.</Text>
            </TouchableOpacity>
            <TouchableOpacity
              className="justify-center items-center bg-[#F97316]"
              style={dynamicButtonStyle}
              onPress={() => handleTap('equal', '=')}
              activeOpacity={0.7}
            >
              <Text className="text-white text-3xl font-normal">=</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}
