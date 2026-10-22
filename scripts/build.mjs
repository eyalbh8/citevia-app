import { build } from 'esbuild';
import { mkdir, cp } from 'node:fs/promises';
for (const app of ['api', 'scanner']) {
  await mkdir(`dist/${app}`, { recursive: true });
  await build({
    entryPoints: [`apps/${app}/src/handler.ts`],
    outfile: `dist/${app}/index.mjs`,
    bundle: true,
    external: ['geoip-country'],
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  console.log(`Built ${app} Lambda`);
  await cp('database', `dist/${app}/database`, { recursive: true });
}

await cp('node_modules/geoip-country', 'dist/api/node_modules/geoip-country', {
  recursive: true,
});

await cp('apps/scanner/assets', 'dist/scanner/agent-assets', { recursive: true });
await cp('node_modules/@resvg/resvg-wasm/index_bg.wasm', 'dist/scanner/agent-assets/index_bg.wasm');

// Bundle country lookup runtime dependencies, while retaining its data and notices.
await build({
  entryPoints: ['node_modules/geoip-country/lib/geoip.js'],
  outfile: 'dist/api/node_modules/geoip-country/lib/geoip.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
});
