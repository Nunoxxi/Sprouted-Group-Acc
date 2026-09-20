import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef6f3',
          100: '#dfeee9',
          200: '#bfdcd2',
          300: '#9cc7b5',
          400: '#66a58b',
          500: '#3f8268',
          600: '#2d6852',
          700: '#204d3d',
          800: '#173c30',
          900: '#122d26',
        },
        sand: {
          50: '#f7f3ee',
          100: '#f1eadf',
        },
        success: '#15803d',
        danger: '#b42318',
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'sans-serif'],
        mono: ['SFMono-Regular', 'Consolas', 'monospace'],
      },
      boxShadow: {
        soft: '0 0 0 1px rgba(15, 23, 42, 0.04)',
      },
      transitionDuration: {
        control: '150ms',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        pulseSuccess: {
          '0%, 100%': { transform: 'scale(1)', opacity: '1' },
          '50%': { transform: 'scale(1.02)', opacity: '0.96' },
        },
      },
      animation: {
        fadeIn: 'fadeIn 150ms ease-out',
        pulseSuccess: 'pulseSuccess 180ms ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
