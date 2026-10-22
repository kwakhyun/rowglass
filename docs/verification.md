# Verification of the first alpha

Checked on 2026-10-23 (Asia/Seoul).

## Automated checks

`npm test` passed all 39 tests on macOS with Node.js 22.21.0. Tests cover exact totals, fractional and large numbers, negative values, row reordering, composite keys, malformed CSV, duplicates, input/output protection, CLI exit codes, hostile HTML strings, and generated module syntax.

`npm run build` produces the app, example, and GitHub Pages document from the same renderer. `npm pack --dry-run` confirmed that the CLI, engine, renderer assets, and CSV examples are included in the package. There are no runtime npm dependencies. The package is not published to npm.

## Browser checks

The app was exercised in the Codex in-app browser using a local HTTP server:

- Selected two UTF-8 CSV files, chose key and metric, and computed `0.30 → 0.45`, with a `+0.15` difference.
- Filtered changed values, searched keys, and inspected before/after row values.
- Downloaded HTML and verified that nonselected cell values were excluded.
- Opened a private-test row, switched to the bundled sample, then downloaded another report. The earlier key, metric values, and filename were absent from the new file. This caught and fixed a stale-dialog export bug.
- Confirmed that duplicate keys produce an explicit error and leave the previous report clearly marked as unchanged.
- Checked 540 px and 1280 px layouts. Fixed wrapped metric totals and an undersized delimiter selector on narrow screens.
- The console reported no errors or warnings during the checked flows.

The public GitHub Pages app was also opened in a browser and its example total change (`+13,400.00`) was verified.

## Limits of these checks

The generated HTML has no external scripts, styles, or imports, and its content security policy disables network connections. Downloaded files were inspected, but an automated `file://` reopen was blocked by the browser tool's URL policy. No claim is made that every browser or operating system was manually tested.

A GitHub Actions matrix is configured for Node 22/24 on Linux, macOS, and Windows. At publication time, the test workflow was not registered in GitHub's workflow listing and manual dispatch returned 404; those hosted tests are unverified. The GitHub Pages deployment completed successfully. No cross-platform CI badge is shown.

The 20 MiB and 100,000-row limits are validation limits, not performance benchmarks. Real user demand and repeat usage have not yet been measured.
