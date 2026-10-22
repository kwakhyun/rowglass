# Rowglass

**Explain a changed CSV total, down to the rows.**

Choose two CSVs, a row key, and a numeric column. Rowglass shows how added rows, removed rows, and changed values account for the difference. Save the result as one interactive HTML file that works offline.

[한국어 안내](README.ko.md) · [Example report](examples/report.html) · [Contributing](CONTRIBUTING.md)

![Rowglass showing the total change and the rows behind it](docs/preview.jpg)

The bundled synthetic example goes from **128,000 to 141,400**:

```text
128,000 + 21,000 added − 8,000 removed + 400 changed = 141,400
```

Atlas increased by 8,000 while Cedar decreased by 7,600. Their combined contribution is just 400; the report lets you inspect both rows.

## Try it

Download and open [examples/report.html](examples/report.html) in a modern browser. It includes the example and accepts your own files. GitHub may display the HTML source; download the file first.

From a checkout, use **Node.js 22 or newer**:

```sh
npm test
npm run build
```

Open `dist/index.html` in your browser. On macOS:

```sh
open dist/index.html
```

There are no npm dependencies to install. The package has not been published to npm; use the checkout commands below.

In the browser, select the before and after files, confirm the delimiter, choose the key and metric, then select **Explain change**. Click a chart contribution to filter its rows, search by key, or inspect a row's exact values. **Save report** keeps an offline HTML copy; **Export JSON** saves the underlying result.

## Use the CLI

```sh
node bin/rowglass.mjs examples/before.csv examples/after.csv --key account --value amount --out report.html --json report.json
```

Repeat `--key` for a composite key, and use `--delimiter tab` for TSV:

```sh
node bin/rowglass.mjs before.tsv after.tsv --key account --key region --value amount --delimiter tab --out report.html
```

Generate a demo or a reusable browser app:

```sh
node bin/rowglass.mjs demo --out demo.html
node bin/rowglass.mjs app --out rowglass.html
node bin/rowglass.mjs --help
```

`--out` is required. Existing output files require `--force`; original input files cannot be replaced, even with that flag. The CLI does not open a browser automatically.

Add `--fail-on-change` for a script or CI job. Exit codes are:

| Code | Meaning |
| --- | --- |
| `0` | Success; without `--fail-on-change`, differences are allowed. |
| `1` | Invalid arguments, invalid data, or an output error. |
| `2` | `--fail-on-change` found added, removed, or numerically changed rows. The report is still written. |

A zero-value row being added or removed also triggers exit `2`. Offsetting row changes trigger it even when the net total is unchanged. Row order, numeric formatting such as `1.0` versus `1.00`, and edits to other cell values do not.

## What the calculation means

For each matched key, the contribution is **after − before**. An added row contributes its full value; a removed row contributes the negative of its old value. Removing a negative value therefore increases the total.

```text
before total + added contribution + removed contribution + changed contribution = after total
```

Totals and row values use exact decimal arithmetic backed by integers. Chart positions use approximate numbers, while the table and JSON preserve exact decimal strings. The report identifies arithmetic contributors; it does not infer business causes.

| Input | Supported behavior |
| --- | --- |
| Files | UTF-8 CSV or TSV with a header, up to 20 MiB and 100,000 data rows per file. |
| CSV fields | Quoted delimiters, escaped quotes, multiline fields, LF/CRLF line endings, and a UTF-8 BOM. Empty physical lines are skipped. |
| Keys | Unique, nonblank values matched exactly, including case and whitespace. Browser: one key. CLI and API: one or more keys. |
| Metric | One decimal column, up to 30 integer digits and 12 decimal places per value. Negative values are supported. |
| Validation | Duplicate or empty headers, malformed records, duplicate or blank keys, missing selected columns, and invalid numbers stop the comparison. |

Numbers must look like `12`, `12.50`, or `-0.25`. Blanks, surrounding spaces, `+12`, `.5`, exponents, currency symbols, and thousands separators are rejected. No rounding, unit conversion, or currency conversion is performed; compare values with the same meaning and units.

Added or removed column names are recorded. Changes to nonmetric cells are outside the comparison. Excel files, database connections, automatic key matching, and business-cause analysis are outside the current scope.

## Local files and saved reports

Rowglass runs locally without a server, uploads, network requests, or telemetry. Generated HTML contains its own code, styles, and report data.

Saved reports include every selected key and metric value, including unchanged rows, plus filenames, column names, totals, and row statuses. Other cell values are excluded. Review the included data before sharing the file.

## Use the engine

The same dependency-free ESM module runs in Node.js and the browser:

```js
import { parseCSV, reconcile } from './src/engine.mjs';

const before = parseCSV('account,amount\nAtlas,0.10\n');
const after = parseCSV('account,amount\nAtlas,0.30\n');
const report = reconcile(before, after, {
  keys: ['account'],
  value: 'amount',
  beforeName: 'before.csv',
  afterName: 'after.csv',
});

console.log(report.totals.delta); // "0.20"
console.log(report.rows[0].status); // "changed"
```

`parseCSV(text, { delimiter: '\t' })` parses TSV and returns `{ headers, rows }`. `reconcile()` returns decimal strings in `totals` and `rows`, numeric row `counts`, added and removed column names in `schema`, and the selected keys and metric. Missing before/after values are `null`. Both functions throw on invalid input.

## Related projects

| Project | Focus |
| --- | --- |
| [csv-diff](https://github.com/simonw/csv-diff) | Row and cell differences between CSV, TSV, or JSON files, available as a Python CLI and library. |
| [daff](https://github.com/paulfitz/daff) | Tabular comparison, patching, merging, and rendered differences. |
| [dataloupe](https://github.com/aurelio-nakamura/dataloupe) | Offline data exploration and key-based file differences in standalone HTML reports. |
| Rowglass | Reconcile one changed total across two CSV snapshots and inspect each row's contribution. |

## Development

Run `npm test` for engine and CLI tests, and `npm run build` after changing the browser code. See [CONTRIBUTING.md](CONTRIBUTING.md) for the file map and browser checks.

The initial test suite was run locally on macOS with Node.js 22. The included GitHub Actions workflow defines Node.js 22/24 jobs on Linux, macOS, and Windows; those hosted jobs have not yet been run.

Licensed under [MIT](LICENSE).
