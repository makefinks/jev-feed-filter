import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/icons', { recursive: true });
await build({entryPoints:['src/background.ts','src/feed.ts','src/controls.ts'],outdir:'dist',bundle:true,target:'chrome120',format:'iife'});
for (const file of ['manifest.json','controls.html','controls.css','feed.css']) await copyFile(`public/${file}`,`dist/${file}`);
for (const file of ['icon16.png','icon32.png','icon48.png','icon128.png']) await copyFile(`public/icons/${file}`,`dist/icons/${file}`);
