import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // The ZCode harness ("DeepSeek Harness.exe") writes files atomically via
    // `.<name>.<pid>.<uuid>.tmpdir/<name>.tmp` inside watched directories; on
    // Windows vite's fs.watch hits EBUSY on those transient files and the unhandled
    // watcher error kills the dev server. They are never real sources — never watch them.
    watch: {
      ignored: [
        '**/.*.tmpdir/**',
        '**/*.tmp',
        '**/docs/**',
        '**/public/**',
        '**/scripts/**',
        '**/*.glb',
        '**/*.gltf',
        '**/*.bin',
      ],
    },
  },
  build: { target: 'es2022' },
});
