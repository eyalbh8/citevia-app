import { build } from 'esbuild';
import { mkdir,cp } from 'node:fs/promises';
for(const app of ['api','scanner']){
  await mkdir(`dist/${app}`,{recursive:true});
  await build({entryPoints:[`apps/${app}/src/handler.ts`],outfile:`dist/${app}/index.mjs`,bundle:true,platform:'node',target:'node22',format:'esm',sourcemap:true,banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"}});
  console.log(`Built ${app} Lambda`);
  await cp('database',`dist/${app}/database`,{recursive:true});
}
