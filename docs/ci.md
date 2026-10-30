# Compare CSV snapshots in CI

Rowglass can fail a job when a numeric metric changes while keeping an HTML report, the full JSON result, changed rows as CSV, and a Markdown summary.

The workflow below runs **from a checkout that contains the Rowglass source**. Its paths use this repository's bundled example files. It is an executable starting point for this repository, not an npm installation command or a published GitHub Action. For another project, check out a reviewed Rowglass revision in a separate directory and adjust the CLI and input paths.

## Keep the report when differences are found

Save this example as a workflow in a trusted checkout, or adapt its steps to an existing workflow:

```yaml
name: Compare CSV totals

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  compare:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Compare snapshots
        id: compare
        shell: bash
        run: |
          set +e
          node bin/rowglass.mjs examples/before.csv examples/after.csv \
            --key account --value amount \
            --out artifacts/report.html \
            --json artifacts/report.json \
            --csv artifacts/changes.csv \
            --markdown artifacts/summary.md \
            --fail-on-change
          result=$?
          set -e
          case "$result" in
            0|2) printf 'exit_code=%s\n' "$result" >> "$GITHUB_OUTPUT" ;;
            *) exit "$result" ;;
          esac

      - name: Add the comparison to the job summary
        if: ${{ always() && steps.compare.outputs.exit_code != '' }}
        shell: bash
        run: cat artifacts/summary.md >> "$GITHUB_STEP_SUMMARY"

      - name: Preserve comparison files
        if: ${{ always() }}
        uses: actions/upload-artifact@v4
        with:
          name: rowglass-comparison
          path: artifacts/
          if-no-files-found: ignore
          retention-days: 7

      - name: Fail when compared values changed
        if: ${{ steps.compare.outputs.exit_code == '2' }}
        shell: bash
        run: exit 2
```

The example datasets contain differences, so this workflow deliberately finishes with a failed comparison after preserving its reports. Replace the paths with your snapshots for a real check.

| CLI exit code | Workflow behavior |
| --- | --- |
| `0` | Comparison succeeded without relevant changes. The summary and files are retained. |
| `1` | Invalid input, options, or output failure. The comparison step fails immediately; the artifact step still attempts to preserve any available files. |
| `2` | Relevant changes were found. The workflow publishes the job summary and artifacts, then fails the final step. |

`always()` is used on the summary and artifact steps so a failed earlier step does not silently skip result handling. It does not turn an invalid comparison into a passing job. The summary also requires the successful comparison step's recorded `0` or `2` result. See GitHub's [status check functions](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions) and [workflow artifact documentation](https://docs.github.com/en/actions/tutorials/store-and-share-data).

## Compare sums for nonunique source keys

Use `--group-by` instead of `--key` when a file contains multiple records for the same group. Repeat it for multiple grouping columns:

```sh
node bin/rowglass.mjs before.csv after.csv --group-by account --group-by service --value amount --out report.html --json report.json --csv changes.csv --markdown summary.md --fail-on-change
```

Grouping is explicit. `--key` continues to require unique keys, and the two modes cannot be combined. Both modes preserve exact decimal arithmetic and reject invalid values.

In group mode, `--fail-on-change` checks added groups, removed groups, and changes to group sums. A group changing from one source row worth `10.00` to two source rows worth `4.00` and `6.00` is unchanged for this check. Source row counts remain available in the result. Added or removed zero-sum groups still count as changes. Offsetting changes between different groups also trigger exit `2`, even when the overall total is unchanged.

## What each output contains

- HTML and JSON contain all compared rows or groups, including unchanged ones.
- CSV contains every added, removed, or numerically changed row or group. It excludes unchanged results.
- Markdown is a summary of the comparison. Use JSON or CSV when you need the complete result rather than a summary.

`--out` remains required. Each output must have a different path, and existing files require `--force`. No output may replace an input file. Fresh hosted runners normally have no existing report files; use fresh artifact paths in reused workspaces.

## Code and data access

This workflow executes the code in its checked-out revision. Use reviewed code and read-only permissions. Do not run untrusted pull request code in a privileged `pull_request_target` workflow.

Rowglass itself does not upload data. The example workflow explicitly sends selected keys, metric values, filenames, and the generated results to GitHub's job summary and artifact storage. These are visible to people with the applicable repository and Actions access; a public repository is not a private place for those results. Only use data you intend to share with that audience. No PR comment or external message is sent by this workflow.

## Check the installable package

```sh
npm run check:package
```

The smoke check packs the local package into a temporary tarball, installs that tarball offline with isolated npm settings, and runs the included CLI from a separate working directory. It checks the bundled demo's JSON totals and generated HTML, then removes the temporary files. It does not publish a package or create a release.
