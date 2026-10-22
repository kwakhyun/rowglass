# Contributing to Rowglass

Useful contributions start with a concrete comparison: two small inputs, the key and metric you chose, and the result you expected. Synthetic or anonymized data is enough to reproduce most problems.

## Run the project

Use Node.js 22 or newer. There are no dependencies to install.

```sh
npm test
npm run build
```

Open `dist/index.html` in a browser. To generate a fresh report from the bundled data:

```sh
node bin/rowglass.mjs demo --out demo.html --force
```

## Find the code

| File | Responsibility |
| --- | --- |
| `src/engine.mjs` | Strict CSV parsing, key matching, exact decimal arithmetic, and the report schema. Shared by Node.js and the browser. |
| `src/render.mjs` | Builds a standalone HTML document with the engine, UI, CSS, and initial report embedded. |
| `src/ui.mjs` | File selection, report rendering, filtering, row inspection, and downloads. |
| `src/ui.css` | Browser layout and styles. |
| `bin/rowglass.mjs` | CLI validation, local file reads, protected output writing, and exit codes. |
| `test/` | Node.js engine and CLI integration tests. |
| `examples/` | Synthetic before/after CSVs and an example report. |

## Keep the result checkable

- Preserve exact decimal arithmetic. Totals, differences, and serialized values must not pass through floating-point arithmetic. Approximate chart geometry is separate from exact labels and values.
- Keep key matching explicit. Never silently merge duplicate keys, trim identifiers, guess currencies, drop invalid rows, or turn missing values into zero.
- Keep the comparison scoped to one metric. “Changed” means the matched metric changed numerically; edits to other cells do not change that status.
- Preserve local operation. The generated file must work without a server or network requests, and changes must not add telemetry.
- Treat CSV values and filenames as data when rendering. Use text nodes and safely escaped JSON rather than inserting input as markup.
- Keep engine and CLI behavior aligned with both READMEs. Add a focused regression test when fixing a calculation, parsing, or file-handling bug.

For a feature request, explain the current task it would make easier and show a small example. Larger format support, automatic matching, and business explanations require explicit design work before implementation.

## Verify a change

Run `npm test`. For a browser change, also rebuild and open the generated HTML, then check the affected flow:

1. Load the example and confirm `128,000 + 21,000 − 8,000 + 400 = 141,400`.
2. Choose two files, select the key and metric, and compare. Check a duplicate-key or invalid-number error if input handling changed.
3. Filter or search rows, open row details, and use the keyboard for the controls you changed.
4. Save the report, reopen it, and verify the same totals and rows. Check JSON export when the report schema changed.
5. Check a narrow viewport when layout changed.

The GitHub workflow defines Node.js 22 and 24 on Linux, macOS, and Windows. Its presence does not mean those jobs have already passed; include the checks you actually ran in your change description.

Generated `dist/index.html` and `examples/report.html` are included so the project can be tried without a build. After a source change that affects them, regenerate both:

```sh
npm run build
node bin/rowglass.mjs demo --out examples/report.html --force
```

Keep user datasets and reports out of contributions. The example files should remain synthetic. Contributions are covered by the project's [MIT license](LICENSE).
