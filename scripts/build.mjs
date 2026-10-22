import { build } from 'esbuild';
import { mkdir, cp, rm } from 'node:fs/promises';
// Remove media renderer assets left by builds before the hero-only blog flow.
await rm('dist/scanner/agent-assets', {recursive:true, force:true});
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

// Bundle country lookup runtime dependencies, while retaining its data and notices.
await build({
  entryPoints: ['node_modules/geoip-country/lib/geoip.js'],
  outfile: 'dist/api/node_modules/geoip-country/lib/geoip.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
});
