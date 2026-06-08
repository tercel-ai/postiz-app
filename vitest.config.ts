import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@gitroom/nestjs-libraries': path.resolve(
        __dirname,
        'libraries/nestjs-libraries/src'
      ),
      '@gitroom/helpers': path.resolve(__dirname, 'libraries/helpers/src'),
      '@gitroom/backend': path.resolve(__dirname, 'apps/backend/src'),
      '@gitroom/react': path.resolve(
        __dirname,
        'libraries/react-shared-libraries/src'
      ),
      '@gitroom/plugins': path.resolve(__dirname, 'libraries/plugins/src'),
      '@gitroom/extension': path.resolve(__dirname, 'apps/extension/src'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    setupFiles: ['dotenv/config'],
  },
});
