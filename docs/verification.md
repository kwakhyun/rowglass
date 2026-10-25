# Verification

Checked on 2026-10-25 (Asia/Seoul), after the UI redesign.

## Automated checks

`npm test` passed all 39 tests on macOS with Node.js 22.21.0. The suite covers exact totals, fractional and large numbers, negative values, row reordering, composite keys, malformed CSV, duplicates, input/output protection, CLI exit codes, hostile HTML strings, and generated module syntax.

`npm run build` produces the app, example, and GitHub Pages document from the same renderer. `npm pack --dry-run` confirmed the CLI, engine, renderer, icon assets, notices, and CSV examples are included. There are no runtime npm dependencies. The package is not published to npm.

## Browser checks

The redesigned app was exercised in the Codex in-app browser over local HTTP using synthetic CSV/TSV fixtures:

- Compared two CSV files: `0.30 → 0.45`, delta `+0.15`.
- Recovered from duplicate-key and mismatched-column errors. The previous report stayed unchanged.
- Selected and replaced files, changed the delimiter and mapping, and swapped before/after. Swapping the example produced `−13,400.00`.
- Closed an edited comparison, verified the draft notice and disabled exports, then discarded it.
- Compared identical files: `0.00` and an explicit no-row-changes message.
- Filtered rows, searched, reset an empty search, sorted keys, and inspected exact row values. Filter button focus remained on the selected button.
- Opened the comparison with Enter, closed it with Escape, and verified focus returned to Compare files. Activated the waterfall's changed-values group with Enter.
- Compared 51-row TSVs: `1,275.00 → 1,326.00`, delta `+51.00`. Pagination moved from rows 1–40 to 41–51.
- Downloaded JSON and HTML while a search showed one row. Both retained all 51 rows and excluded unselected source cells. Reopened the downloaded HTML over local HTTP and verified its restored total and pagination.
- Inspected a private-test row, switched to the bundled example, and downloaded a report. Previous fixture keys, filenames, search terms, and unselected note values were absent.
- Verified downloaded HTML retains the embedded Lucide/Feather license notices.
- Inspected 320 px, 390 px, and 1280 px layouts. Narrow screens had no page-level horizontal overflow. Mobile rows show the difference and both original values. At 1280×720, the comparison's close and primary buttons remained inside the viewport.
- The console reported no errors or warnings during the checked flows.

The redesign also preserves the printed table range, names dialogs for assistive technology, describes selected files by filename, respects reduced motion, and caches sorted rows. These were checked in code; native drag/drop, printed PDF output, and screen-reader speech were not independently exercised.

## Limits

Generated HTML has no external scripts, styles, or imports, and its content security policy disables network connections. The downloaded file was reopened over local HTTP; automated `file://` navigation is blocked by the browser tool's URL policy. This is not a claim that every browser or operating system was tested.

A GitHub Actions matrix is configured for Node 22/24 on Linux, macOS, and Windows. The prior test workflow was not registered in GitHub's workflow listing and manual dispatch returned 404; those hosted tests remain unverified. No cross-platform CI badge is shown.

The 20 MiB and 100,000-row limits are validation limits, not performance benchmarks. No accessibility certification or measured user-conversion improvement is claimed.
