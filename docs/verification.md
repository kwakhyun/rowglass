# Verification

Updated on 2026-10-30 (Asia/Seoul), after adding explicit grouping and portable exports.

## Automated checks

`npm test` passed all 67 tests on macOS with Node.js 22.21.0. The suite covers exact totals, fractional and large numbers, negative values, row reordering, composite keys, malformed CSV, duplicates, explicit group sums, source row counts, input/output protection across four formats, CLI exit codes, CSV formula protection, hostile Markdown/HTML strings, exact top-change ranking, and generated module syntax.

`npm run build` produces the app, example, and GitHub Pages document from the same renderer. `npm run check:package` packed and installed a local tarball offline, then verified the packaged CLI and demo totals from outside the checkout. This checks the CLI, shared sources, icon assets, notices, and examples needed at runtime. There are no runtime npm dependencies. The package is not published to npm.

## New browser checks

The browser and CLI share the same calculation and text exporters. The following were exercised in the Codex in-app browser over local HTTP with synthetic fixtures:

- Selected account + service as a composite key. Unique-row mode rejected the duplicated group and preserved the previous report. Switching explicitly to Group & sum succeeded.
- Reconciled the line-item example: `285.30 → 310.30`, delta `+25.00`, with source rows `6 → 5` and groups `5 → 4`. Atlas / Compute showed `150.30 → 180.30` and two source rows on each side.
- Compared unique account + region rows with offsetting `+0.05` and `−0.05` contributions. The app reported two changed rows and a zero net change.
- Reopened the editor and confirmed both key selections persisted. Changing comparison mode created a draft and disabled downloads until applied or discarded.
- Filtered the grouped table to one result, downloaded CSV/Markdown/HTML, and inspected their contents. CSV contained all five changed groups; Markdown had the totals and all five changes; HTML retained all six groups including the unchanged group.
- Reopened the downloaded grouped HTML over local HTTP. The exact totals, grouping, source counts, and row inspection still worked.
- Exported a synthetic private fixture and confirmed unselected note values were excluded. Switched to the bundled example and confirmed former keys, filenames, notes, and editor values were absent from the new HTML.
- Inspected 320 px and 390 px mobile layouts and 1280 px desktop. No page-level horizontal overflow was present. The narrow comparison dialog kept its close and compare controls inside the viewport. The export menu fit the mobile viewport and supported Escape.
- No console errors or warnings were reported during these flows.

## Prior UI checks (2026-10-25)

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

The six-job Node 22/24 matrix on Linux, macOS, and Windows passed for the previous UI revision `6e658d3`: [test run 40191652398](https://github.com/kwakhyun/rowglass/actions/runs/40191652398). Its [Pages deployment](https://github.com/kwakhyun/rowglass/actions/runs/40191651991) also passed. The current grouping/export revision adds the offline package smoke check to that matrix; its hosted run is recorded after publication. The earlier statement that hosted tests were unverified is no longer current.

The 20 MiB and 100,000-row limits are validation limits, not performance benchmarks. No accessibility certification or measured user-conversion improvement is claimed.
