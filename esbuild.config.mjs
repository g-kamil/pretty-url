import esbuild from 'esbuild';
import { builtinModules } from 'node:module';

const production = process.argv[2] === 'production';
const options = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/view', ...builtinModules],
  format: 'cjs',
  target: 'es2021',
  outfile: 'main.js',
  platform: 'browser',
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'info',
};

if (production) {
  await esbuild.build(options);
} else {
  const context = await esbuild.context(options);
  await context.watch();
}
