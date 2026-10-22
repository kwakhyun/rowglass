import { mkdir, writeFile } from 'node:fs/promises';
import { renderApp } from '../src/render.mjs';

const html = await renderApp();
for (const directory of ['dist', 'docs']) {
  await mkdir(new URL(`../${directory}/`, import.meta.url), { recursive: true });
  await writeFile(new URL(`../${directory}/index.html`, import.meta.url), html);
}
await writeFile(new URL('../examples/report.html', import.meta.url), html);
console.log('Built dist/index.html, docs/index.html, and examples/report.html.');
