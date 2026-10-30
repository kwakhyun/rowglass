import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function findNpmCLI() {
  const candidates = [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* Try the next standard Node installation layout. */ }
  }
  throw new Error('Could not find the npm CLI. Run this check with npm run check:package.');
}

function execute(program, args, options) {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${args[0] || program} exited ${result.status ?? result.signal}:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

const temporary = await mkdtemp(join(tmpdir(), 'rowglass-package-'));
try {
  const npmCLI = await findNpmCLI();
  const userConfig = join(temporary, 'user.npmrc');
  const globalConfig = join(temporary, 'global.npmrc');
  const installDirectory = join(temporary, 'installed');
  const runDirectory = join(temporary, 'run');
  await Promise.all([
    writeFile(userConfig, ''), writeFile(globalConfig, ''),
    mkdir(installDirectory), mkdir(runDirectory),
  ]);
  // Use isolated npm config and cache. Neither command runs lifecycle scripts
  // or accesses the network, and no package files are written into the checkout.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
  const npmOptions = ['--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--userconfig', userConfig, '--globalconfig', globalConfig, '--cache', join(temporary, 'cache')];
  const packed = JSON.parse(execute(process.execPath, [npmCLI, 'pack', '--json', '--pack-destination', temporary, ...npmOptions], { cwd: root, env }));
  assert.equal(packed.length, 1, 'Pack exactly one local package.');
  const tarball = join(temporary, packed[0].filename);
  // npm extracts the local tarball portably, including on Windows. Offline mode
  // also proves that the distributable needs no downloaded dependencies.
  execute(process.execPath, [npmCLI, 'install', '--prefix', installDirectory, '--no-package-lock', tarball, ...npmOptions], { cwd: installDirectory, env });
  const sourcePackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const installedRoot = join(installDirectory, 'node_modules', ...sourcePackage.name.split('/'));
  const installedPackage = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'));
  const cli = resolve(installedRoot, installedPackage.bin.rowglass);
  assert.equal(execute(process.execPath, [cli, '--version'], { cwd: runDirectory }).trim(), sourcePackage.version);
  execute(process.execPath, [cli, 'demo', '--out', 'report.html', '--json', 'report.json'], { cwd: runDirectory });
  const report = JSON.parse(await readFile(join(runDirectory, 'report.json'), 'utf8'));
  assert.equal(report.totals.before, '128000.00');
  assert.equal(report.totals.after, '141400.00');
  assert.equal(report.totals.delta, '13400.00');
  assert.deepEqual(report.counts, { before: 8, after: 9, added: 2, removed: 1, changed: 2, unchanged: 5 });
  assert.match(await readFile(join(runDirectory, 'report.html'), 'utf8'), /<!doctype html>/i);
  console.log(`Package smoke check passed: ${sourcePackage.name}@${sourcePackage.version}, installed from its tarball and run outside the checkout.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
