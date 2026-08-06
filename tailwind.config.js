/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        tactical: {
          bg: '#080C14',
          card: '#0F172A',
          border: '#1E293B',
          borderLight: '#334155',
          cyan: '#00F0FF',
          green: '#00FF66',
          red: '#EF4444',
          redDark: '#DC2626',
          text: '#F8FAFC',
          textMuted: '#94A3B8',
          textDim: '#64748B',
          textDark: '#475569',
          dream: '#C084FC',
          dreamBg: '#581C87',
        },
      },
    },
  },
  plugins: [],
};
