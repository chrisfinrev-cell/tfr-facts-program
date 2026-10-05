import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        facts: {
          bg: '#0f172a',
          card: '#1e293b',
          line: '#334155',
          accent: '#38bdf8',
          action: '#0284c7'
        }
      }
    }
  },
  plugins: []
};

export default config;
