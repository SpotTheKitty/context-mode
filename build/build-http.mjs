// Flat, self-contained Node entry: no node_modules or repository paths at deployment.
import {build} from 'esbuild';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const out=resolve(process.argv[2] ?? join(root,'release-out'));
await build({absWorkingDir:root,entryPoints:['src/entries/server-http.ts'],outfile:join(out,'server-http.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',external:['node:*'],banner:{js:'import {createRequire as __cmCreateRequire} from "node:module"; const require=__cmCreateRequire(import.meta.url);'}});
