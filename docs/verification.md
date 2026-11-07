# Verification

Updated on 2026-11-07, after the input and report usability changes (encodings, separators, live column checks, increase/decrease split).

## Input and report usability checks (2026-11-07)

`npm test` passed all 79 tests on Linux with Node.js 22.23.4. New tests cover strict UTF-8 and EUC-KR (CP949) decoding, header-based separator detection, error messages that name the offending value and count the remaining problems, mapping inspection, exact increase/decrease and concentration figures, similar-key hints, the Markdown increase/decrease rows, CLI `--encoding`, `--delimiter semicolon|auto`, data-only outputs without `--out`, and the recorded comparison time. `npm run build` and `npm run check:package` passed.

The rebuilt `dist/index.html` was exercised in headless Chromium (Playwright) from a `file://` URL:

- At 1280×800, a duplicate-key comparison now scrolls the error into view, moves focus to it, and offers **Use Group & sum** and **Add key columns**. Before this change the same error rendered below the visible part of the dialog.
- CP949 files with Korean headers failed as UTF-8 with a **Read as Korean (EUC-KR)** action. One click read both files, selected `고객` and `매출` automatically, and compared them (`+500`).
- Semicolon files were detected automatically and labeled as such. The live check reported `"1,300.00"` at record 2 before comparing.
- A report with `"Grove "` removed and `grove` added showed the similar-key notice and a column-difference notice. CSV and HTML downloads were named `rowglass-sim-before-vs-sim-after-…`. **Copy Markdown** put the summary on the clipboard.
- The downloaded HTML contained `generatedAt`, excluded the unselected `region` values, and reopened with the same total, title, comparison time, and notices.
- Two synthetic files dropped on the page opened the comparison dialog and were ordered by file name (`2026-01.csv` before `2026-02.csv`). The page overlay appeared while dragging and cleared after the drop.
- With 100,000-row synthetic files, reading and the first column check took about 0.4 s, re-checking both files after a mode change about 0.1 s, and comparing and rendering about 0.5 s.
- The example report shows `↑ +8,000.00` and `↓ −7,600.00` under changed values, gross movement `44,600.00`, and a chart axis that starts at `86,000.00` with break marks and a note.
- At 390 px, filter chips wrap instead of scrolling out of view, and the comparison dialog has no horizontal overflow.
- No console errors or warnings were reported during these flows.

Drag and drop was simulated with synthetic `DataTransfer` events, not dragged from an operating system file manager. Firefox, Safari, and screen-reader speech were not checked. Hosted CI results for this change are not recorded here.

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

The six-job Node 22/24 matrix on Linux, macOS, and Windows passed for the grouping/export implementation `4cc7871057a9c94bbd11114d0d2b868b242d722a`: [test run 41038763742](https://github.com/kwakhyun/rowglass/actions/runs/41038763742). All six jobs passed tests, the build, and the offline package smoke check. Its [Pages deployment](https://github.com/kwakhyun/rowglass/actions/runs/41038762935) also passed. The live Pages app was then checked for the new group example, exact totals, composite-key details, and no console errors. The earlier statement that hosted tests were unverified is no longer current.

The 20 MiB and 100,000-row limits are validation limits, not performance benchmarks. No accessibility certification or measured user-conversion improvement is claimed.
