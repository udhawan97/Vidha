import { build } from 'esbuild';

await build({
  bundle: true,
  entryPoints: ['src/main.ts'],
  external: ['pg', 'pg-native'],
  format: 'esm',
  outfile: 'dist/main.mjs',
  platform: 'node',
});
