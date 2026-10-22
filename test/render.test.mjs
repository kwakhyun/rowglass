import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { reconcile } from '../src/engine.mjs';
import { renderApp, safeJSON } from '../src/render.mjs';

function scripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].map((match) => ({ attributes: match[1], contents: match[2] }));
}

function embeddedState(html) {
  const block = scripts(html).find((script) => /id="rowglass-data"/.test(script.attributes));
  assert.ok(block, 'The standalone report contains its serialized state.');
  return JSON.parse(block.contents);
}

test('JSON embedded in HTML round-trips hostile strings without script delimiters', () => {
  const payload = {
    text: '</script><script>globalThis.ROWGLASS_INJECTED=true</script><!--',
    punctuation: '<>&\u2028\u2029',
    quotes: '\"\\\n\r\t',
  };
  const encoded = safeJSON(payload);
  assert.deepEqual(JSON.parse(encoded), payload);
  assert.doesNotMatch(encoded, /[<>&\u2028\u2029]/);
  assert.match(encoded, /\\u003c\/script\\u003e/);
});

test('hostile keys, filenames, and column names remain data in the standalone report', async () => {
  const keyName = 'account</script><script>keyColumnAttack()</script>';
  const metricName = 'amount<img src=x onerror=metricAttack()>';
  const key = '</script><script>globalThis.KEY_ATTACK=true</script>';
  const beforeName = '"><img src=x onerror=filenameAttack()>.csv';
  const afterName = '</script><script>globalThis.FILE_ATTACK=true</script>.csv';
  const report = reconcile(
    { headers: [keyName, metricName], rows: [[key, '0.10']] },
    { headers: [keyName, metricName], rows: [[key, '0.30']] },
    { keys: [keyName], value: metricName, beforeName, afterName },
  );
  const html = await renderApp(report);
  assert.equal(scripts(html).length, 2, 'Payloads cannot create additional script elements.');
  assert.equal((html.match(/<\/script\s*>/gi) || []).length, 2);
  assert.ok(!html.includes(key));
  assert.ok(!html.includes(beforeName));
  assert.ok(!html.includes(afterName));
  assert.deepEqual(embeddedState(html).report, report);
  assert.equal(embeddedState(html).sample, false);
});

test('a generated report excludes unselected cell values and original CSV contents', async () => {
  const confidentialBefore = 'private-before-note-05b7c9';
  const confidentialAfter = 'private-after-note-419fa6';
  const report = reconcile(
    { headers: ['account', 'amount', 'internal_note'], rows: [['001', '10.1', confidentialBefore]] },
    { headers: ['account', 'amount', 'internal_note'], rows: [['001', '10.2', confidentialAfter]] },
    { keys: ['account'], value: 'amount' },
  );
  const html = await renderApp(report);
  assert.ok(!html.includes(confidentialBefore));
  assert.ok(!html.includes(confidentialAfter));
  const state = embeddedState(html);
  assert.deepEqual(state.report.rows, [
    { key: ['001'], before: '10.1', after: '10.2', delta: '0.1', status: 'changed' },
  ]);
  assert.equal('beforeDataset' in state, false);
  assert.equal('afterDataset' in state, false);
});

test('combined engine and UI form a syntactically valid, self-contained browser module', async () => {
  const html = await renderApp();
  const blocks = scripts(html);
  const module = blocks.find((script) => /type="module"/.test(script.attributes));
  assert.ok(module);
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: module.contents,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(module.contents, /^\s*import\s+(?:["'{*]|[\w$]+\s)/m, 'The embedded module does not import other files.');
  for (const block of blocks) assert.doesNotMatch(block.attributes, /\bsrc\s*=/i);
  assert.doesNotMatch(html, /<link\b[^>]*\brel=["']stylesheet["']/i);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /default-src 'none'/);
  assert.equal(embeddedState(html).sample, true);
  assert.deepEqual(embeddedState(html).report, embeddedState(html).example);
});

test('renderer preserves exact negative, zero, and very large totals in its serialized state', async () => {
  const report = reconcile(
    { headers: ['account', 'amount'], rows: [['credit', '-999999999999999999999999999999.01'], ['zero', '-0.00']] },
    { headers: ['account', 'amount'], rows: [['credit', '-999999999999999999999999999999.00']] },
  );
  const state = embeddedState(await renderApp(report));
  assert.equal(state.report.totals.before, '-999999999999999999999999999999.01');
  assert.equal(state.report.totals.after, '-999999999999999999999999999999.00');
  assert.equal(state.report.totals.delta, '0.01');
  assert.equal(state.report.totals.removed, '0.00');
  assert.equal(state.report.rows[1].status, 'removed');
});
