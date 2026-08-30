import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const buildIdentity =
  process.env.VIDHA_BUILD_ID ?? process.env.GITHUB_SHA ?? 'local-development';

if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u.test(buildIdentity)) {
  throw new Error(
    'VIDHA_BUILD_ID must contain 1-80 letters, numbers, dots, underscores, or hyphens.',
  );
}

export default defineConfig({
  define: {
    'import.meta.env.VITE_VIDHA_BUILD_ID': JSON.stringify(buildIdentity),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      manifest: {
        name: 'Vidha',
        short_name: 'Vidha',
        description:
          'A pre-alpha contingency-relay prototype for deliberate, recipient-specific handoffs.',
        theme_color: '#141f45',
        background_color: '#f7f0e2',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: '/pwa-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/pwa-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        navigateFallback: '/index.html',
        globPatterns: ['**/*.{html,js,css,svg,png,woff2}'],
      },
    }),
  ],
});
