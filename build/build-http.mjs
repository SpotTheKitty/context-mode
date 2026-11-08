// Flat, self-contained Node entry: no node_modules or repository paths at deployment.
import {build} from 'esbuild';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const out=resolve(process.argv[2] ?? join(root,'http-out'));
for (const name of ['server-http','hook-http']) {
  await build({absWorkingDir:root,entryPoints:[`src/entries/${name}.ts`],outfile:join(out,`${name}.mjs`),bundle:true,platform:'node',format:'esm',target:'node24',external:['node:*'],banner:{js:'import {createRequire as __cmCreateRequire} from "node:module"; const require=__cmCreateRequire(import.meta.url);'}});
}
