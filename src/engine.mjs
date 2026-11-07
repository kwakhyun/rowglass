/** Exact, dependency-free CSV reconciliation for Node.js and browsers. */

import { decodeEucKr } from './euc-kr.mjs';

export const MAX_ROWS = 100_000;
export const MAX_TEXT_BYTES = 20 * 1024 * 1024;
export const MAX_DECIMAL_PLACES = 12;
export const MAX_INTEGER_DIGITS = 30;
export const TEXT_ENCODINGS = Object.freeze(['utf-8', 'euc-kr']);
export const DETECTABLE_DELIMITERS = Object.freeze([',', '\t', ';']);

/**
 * Strictly decode file bytes. euc-kr is the WHATWG decoder, which also covers
 * the CP949 (Unified Hangul Code) files that Korean Windows editions of Excel
 * save as CSV. Invalid byte sequences fail instead of producing replacement
 * characters, and euc-kr refuses files that start with a UTF-8 byte order mark.
 */
export function decodeText(bytes, encoding = 'utf-8') {
  if (!TEXT_ENCODINGS.includes(encoding)) {
    throw new Error(`Unsupported text encoding ${quoteText(String(encoding))}. Use utf-8 or euc-kr.`);
  }
  if (encoding === 'euc-kr') {
    const view = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
    if (view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) {
      throw new Error('File starts with a UTF-8 byte order mark, so it is UTF-8 text, not EUC-KR (CP949).');
    }
    try {
      // Browsers implement the WHATWG decoder natively; Node.js's ICU converter does not.
      return decodeEucKr ? decodeEucKr(view) : new TextDecoder('euc-kr', { fatal: true }).decode(view);
    } catch {
      throw new Error('File is not valid EUC-KR (CP949) text.');
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('File is not valid UTF-8 text.');
  }
}

/**
 * Choose the comma, tab, or semicolon separator from the header and the first
 * 20 data records, counting candidates outside quotes. A candidate that appears
 * in the header and gives every sampled record the same field count wins; among
 * several, the one with most header fields wins. Without such a candidate, the
 * most frequent header candidate wins. Ties keep the comma default.
 */
export function detectDelimiter(text) {
  if (typeof text !== 'string') throw new TypeError('CSV input must be a string.');
  const empty = () => new Map(DETECTABLE_DELIMITERS.map((delimiter) => [delimiter, 0]));
  const records = [];
  let counts = null;
  let quoted = false;
  let position = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; position < text.length && records.length <= 20; position += 1) {
    const char = text[position];
    if (!quoted && (char === '\r' || char === '\n')) {
      if (counts) records.push(counts);
      counts = null;
      continue;
    }
    counts ||= empty();
    if (char === '"') quoted = !quoted;
    else if (!quoted && counts.has(char)) counts.set(char, counts.get(char) + 1);
  }
  if (counts && position >= text.length) records.push(counts);
  if (!records.length) return ',';
  const [header, ...data] = records;
  const consistent = DETECTABLE_DELIMITERS.filter((delimiter) => header.get(delimiter) > 0
    && data.every((record) => record.get(delimiter) === header.get(delimiter)));
  let best = consistent[0] || ',';
  for (const delimiter of consistent.length ? consistent : DETECTABLE_DELIMITERS) {
    if (header.get(delimiter) > header.get(best)) best = delimiter;
  }
  return best;
}

function validateHeaders(headers, label) {
  if (!Array.isArray(headers) || headers.length === 0) {
    throw new Error(`${label} must contain a header row.`);
  }
  const seen = new Set();
  for (const header of headers) {
    if (typeof header !== 'string' || header.trim() === '') {
      throw new Error(`${label} contains an empty header.`);
    }
    if (seen.has(header)) throw new Error(`${label} contains duplicate header ${quoteText(header)}.`);
    seen.add(header);
  }
}

/**
 * Parse strict CSV, preserving the exact contents of every field.
 * Empty physical lines are ignored; a quoted empty field is a real record.
 * Whitespace-only fields are preserved. Quotes must surround the whole field.
 */
export function parseCSV(text, { delimiter = ',' } = {}) {
  if (typeof text !== 'string') throw new TypeError('CSV input must be a string.');
  if (typeof delimiter !== 'string' || delimiter.length !== 1 || /["\r\n\u0000\uFEFF]/.test(delimiter)) {
    throw new Error('CSV delimiter must be one character other than a quote or line break.');
  }
  if (text.length > MAX_TEXT_BYTES || new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) {
    throw new Error('CSV input exceeds the 20 MiB UTF-8 limit.');
  }

  let position = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let headers;
  const rows = [];
  const isLineBreak = (char) => char === '\r' || char === '\n';
  const consumeLineBreak = () => {
    if (text[position] === '\r' && text[position + 1] === '\n') position += 2;
    else position += 1;
  };

  while (position < text.length) {
    if (isLineBreak(text[position])) {
      consumeLineBreak();
      continue;
    }
    const record = [];
    const recordNumber = headers ? rows.length + 2 : 1;
    while (true) {
      let field;
      if (text[position] === '"') {
        position += 1;
        let start = position;
        const pieces = [];
        let closed = false;
        while (position < text.length) {
          if (text[position] !== '"') {
            position += 1;
            continue;
          }
          pieces.push(text.slice(start, position));
          if (text[position + 1] === '"') {
            pieces.push('"');
            position += 2;
            start = position;
          } else {
            position += 1;
            closed = true;
            break;
          }
        }
        if (!closed) throw new Error(`CSV record ${recordNumber} contains an unclosed quoted field.`);
        field = pieces.join('');
        if (position < text.length && text[position] !== delimiter && !isLineBreak(text[position])) {
          throw new Error(`CSV record ${recordNumber} contains characters after a closing quote.`);
        }
      } else {
        const start = position;
        while (position < text.length && text[position] !== delimiter && !isLineBreak(text[position])) {
          if (text[position] === '"') throw new Error(`CSV record ${recordNumber} contains a quote inside an unquoted field.`);
          position += 1;
        }
        field = text.slice(start, position);
      }
      record.push(field);
      if (text[position] === delimiter) {
        position += 1;
        continue;
      }
      if (position < text.length) consumeLineBreak();
      break;
    }
    if (!headers) {
      validateHeaders(record, 'CSV');
      headers = record;
    } else {
      if (record.length !== headers.length) {
        throw new Error(`CSV record ${recordNumber} has ${record.length} fields; expected ${headers.length}.`);
      }
      if (rows.length === MAX_ROWS) throw new Error('CSV input exceeds the 100,000 row limit.');
      rows.push(record);
    }
  }
  if (!headers) throw new Error('CSV input must contain a header row.');
  return { headers, rows };
}

function validateDataset(dataset, label) {
  if (!dataset || !Array.isArray(dataset.rows)) throw new Error(`${label} must be a parsed CSV dataset.`);
  validateHeaders(dataset.headers, label);
  if (dataset.rows.length > MAX_ROWS) throw new Error(`${label} exceeds the 100,000 row limit.`);
  for (let index = 0; index < dataset.rows.length; index += 1) {
    const row = dataset.rows[index];
    if (!Array.isArray(row) || row.length !== dataset.headers.length || row.some((cell) => typeof cell !== 'string')) {
      throw new Error(`${label} record ${index + 2} must have ${dataset.headers.length} string fields.`);
    }
  }
}

function decimalProblem(value) {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) {
    return 'must be a decimal number without blanks, spaces, exponents, or grouping separators';
  }
  const [integer, fraction = ''] = value.replace(/^-/, '').split('.');
  if (integer.length > MAX_INTEGER_DIGITS) return 'exceeds the 30 integer digit limit';
  if (fraction.length > MAX_DECIMAL_PLACES) return 'exceeds the 12 decimal place limit';
  return '';
}

/** True when a cell is an exact decimal that Rowglass can total without conversion. */
export function isExactDecimal(value) {
  return decimalProblem(value) === '';
}

// Only called after decimalProblem() accepted the value.
function parseDecimal(value) {
  const negative = value.startsWith('-');
  const [integer, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const coefficient = BigInt(integer + fraction) * (negative ? -1n : 1n);
  return { coefficient, scale: fraction.length };
}

const ISSUE_EXAMPLES = 3;

// Quote source text for messages. Control, bidi, and invisible format
// characters become visible escapes, so a cell cannot restyle a terminal.
function quoteText(value) {
  return JSON.stringify(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115f\u1160\u3164\uffa0]/gu,
    (char) => Array.from({ length: char.length }, (_, index) => `\\u${char.charCodeAt(index).toString(16).padStart(4, '0')}`).join(''));
}

function quoteCell(value) {
  const chars = Array.from(value);
  return quoteText(chars.length > 40 ? `${chars.slice(0, 39).join('')}…` : value);
}

function noteIssue(issue, example) {
  issue.count += 1;
  if (issue.examples.length < ISSUE_EXAMPLES) issue.examples.push(example);
}

function validateMappingOptions(keys, value) {
  if (!Array.isArray(keys) || keys.length === 0 || keys.some((key) => typeof key !== 'string' || key.trim() === '') || new Set(keys).size !== keys.length) {
    throw new Error('Choose one or more distinct, nonempty key columns.');
  }
  if (typeof value !== 'string' || value.trim() === '') throw new Error('Choose a nonempty value column.');
}

/**
 * Scan every record once. Problems are counted rather than thrown so callers can
 * report the full extent of an input issue; records are only built while clean.
 */
function scanDataset(dataset, { keys, value, aggregate }, build) {
  const scan = {
    rows: dataset.rows.length,
    keys: 0,
    missing: [...keys, value].filter((column) => !dataset.headers.includes(column)),
    blankKeys: { count: 0, examples: [] },
    duplicateKeys: { count: 0, examples: [] },
    invalidValues: { count: 0, examples: [] },
  };
  const records = new Map();
  let scale = 0;
  if (scan.missing.length) return { scan, records, scale };
  const keyIndices = keys.map((key) => dataset.headers.indexOf(key));
  const valueIndex = dataset.headers.indexOf(value);
  const seen = new Set();
  for (let index = 0; index < dataset.rows.length; index += 1) {
    const row = dataset.rows[index];
    const record = index + 2;
    const key = keyIndices.map((column) => row[column]);
    const raw = row[valueIndex];
    const problem = decimalProblem(raw);
    if (problem) noteIssue(scan.invalidValues, { record, value: raw, problem });
    if (key.some((part) => part.trim() === '')) {
      noteIssue(scan.blankKeys, { record, key });
      continue;
    }
    const identity = JSON.stringify(key);
    if (seen.has(identity) && !aggregate) {
      noteIssue(scan.duplicateKeys, { record, key });
      continue;
    }
    seen.add(identity);
    if (!build || scan.invalidValues.count || scan.blankKeys.count || scan.duplicateKeys.count) continue;
    const decimal = parseDecimal(raw);
    scale = Math.max(scale, decimal.scale);
    const existing = records.get(identity);
    if (existing) {
      const groupScale = Math.max(existing.decimal.scale, decimal.scale);
      existing.decimal = {
        coefficient: existing.decimal.coefficient * 10n ** BigInt(groupScale - existing.decimal.scale)
          + decimal.coefficient * 10n ** BigInt(groupScale - decimal.scale),
        scale: groupScale,
      };
      existing.count += 1;
    } else {
      records.set(identity, { key, decimal, count: 1 });
    }
  }
  scan.keys = seen.size;
  return { scan, records, scale };
}

function scanError(scan, label, value) {
  if (scan.missing.length) return `${label} is missing column ${quoteText(scan.missing[0])}.`;
  const more = (issue, one, many) => {
    const extra = issue.count - 1;
    return extra > 0 ? ` ${extra.toLocaleString('en-US')} more ${extra === 1 ? one : many}.` : '';
  };
  const { blankKeys, duplicateKeys, invalidValues } = scan;
  if (blankKeys.count) {
    return `${label} record ${blankKeys.examples[0].record} has a blank key.${more(blankKeys, 'record has a blank key', 'records have blank keys')}`;
  }
  if (duplicateKeys.count) {
    const [first] = duplicateKeys.examples;
    return `${label} record ${first.record} has duplicate key ${quoteText(first.key)}.${more(duplicateKeys, 'record repeats a key', 'records repeat keys')}`;
  }
  if (invalidValues.count) {
    const [first] = invalidValues.examples;
    return `${label} record ${first.record}, column ${quoteText(value)} ${first.problem}; found ${quoteCell(first.value)}.${more(invalidValues, 'value in this column is invalid', 'values in this column are invalid')}`;
  }
  return '';
}

/**
 * Preview a key/value mapping before comparing. Returns row and distinct key
 * counts, missing columns, and counts with up to three examples of blank keys,
 * duplicate keys (unique-row mode only), and invalid numbers. Data problems are
 * reported, never thrown.
 */
export function inspectMapping(dataset, { keys, value, aggregate = false } = {}) {
  validateDataset(dataset, 'Dataset');
  validateMappingOptions(keys, value);
  return scanDataset(dataset, { keys, value, aggregate: aggregate === true }, false).scan;
}

/** Format an integer coefficient at the given decimal scale, without rounding. */
export function formatDecimal(coefficient, scale = 0) {
  if (typeof coefficient !== 'bigint') throw new TypeError('Decimal coefficient must be a BigInt.');
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_DECIMAL_PLACES) {
    throw new Error('Decimal scale must be an integer from 0 to 12.');
  }
  const sign = coefficient < 0n ? '-' : '';
  const digits = (coefficient < 0n ? -coefficient : coefficient).toString();
  if (scale === 0) return sign + digits;
  const padded = digits.padStart(scale + 1, '0');
  return `${sign}${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}

/**
 * Reconcile one exact decimal metric using one or more string identity columns.
 * Nonmetric changes are intentionally ignored. Missing/blank keys and invalid
 * numbers fail the entire operation rather than silently dropping rows. Duplicate
 * keys also fail unless aggregate is true, which sums each key's input values.
 * Group statuses depend on sums, not changes to their source rows or row counts.
 * All returned numbers use the largest input decimal scale. Removed totals are
 * signed contributions: removing a negative value contributes a positive delta.
 * Output order follows before rows, then newly added rows in their after order.
 */
export function reconcile(beforeDataset, afterDataset, options = {}) {
  const { keys = ['account'], value = 'amount', beforeName = 'before.csv', afterName = 'after.csv', aggregate = false } = options;
  validateMappingOptions(keys, value);
  if (typeof beforeName !== 'string' || typeof afterName !== 'string') throw new Error('Dataset names must be strings.');
  if (typeof aggregate !== 'boolean') throw new TypeError('The aggregate option must be a boolean.');
  validateDataset(beforeDataset, 'Before CSV');
  validateDataset(afterDataset, 'After CSV');

  let scale = 0;
  const read = (dataset, label) => {
    const result = scanDataset(dataset, { keys, value, aggregate }, true);
    const message = scanError(result.scan, label, value);
    if (message) throw new Error(message);
    scale = Math.max(scale, result.scale);
    return result.records;
  };

  const before = read(beforeDataset, 'Before CSV');
  const after = read(afterDataset, 'After CSV');
  const scaleRecords = (records) => {
    for (const record of records.values()) {
      record.units = record.decimal.coefficient * 10n ** BigInt(scale - record.decimal.scale);
    }
  };
  scaleRecords(before);
  scaleRecords(after);

  const totals = { before: 0n, after: 0n, delta: 0n, added: 0n, removed: 0n, changed: 0n };
  const counts = { before: before.size, after: after.size, added: 0, removed: 0, changed: 0, unchanged: 0 };
  const rows = [];
  const append = (oldRecord, newRecord) => {
    const oldUnits = oldRecord?.units ?? 0n;
    const newUnits = newRecord?.units ?? 0n;
    const delta = newUnits - oldUnits;
    const status = !oldRecord ? 'added' : !newRecord ? 'removed' : delta === 0n ? 'unchanged' : 'changed';
    counts[status] += 1;
    totals.before += oldUnits;
    totals.after += newUnits;
    if (status !== 'unchanged') totals[status] += delta;
    rows.push({
      key: [...(oldRecord ?? newRecord).key],
      before: oldRecord ? formatDecimal(oldUnits, scale) : null,
      after: newRecord ? formatDecimal(newUnits, scale) : null,
      delta: formatDecimal(delta, scale),
      status,
      ...(aggregate ? { beforeCount: oldRecord?.count ?? 0, afterCount: newRecord?.count ?? 0 } : {}),
    });
  };
  for (const [identity, record] of before) append(record, after.get(identity));
  for (const [identity, record] of after) if (!before.has(identity)) append(undefined, record);
  totals.delta = totals.after - totals.before;
  return {
    version: 1,
    keys: [...keys],
    value,
    beforeName,
    afterName,
    ...(aggregate ? { aggregation: 'sum', sourceCounts: { before: beforeDataset.rows.length, after: afterDataset.rows.length } } : {}),
    scale,
    totals: Object.fromEntries(Object.entries(totals).map(([name, units]) => [name, formatDecimal(units, scale)])),
    counts,
    schema: {
      added: afterDataset.headers.filter((header) => !beforeDataset.headers.includes(header)),
      removed: beforeDataset.headers.filter((header) => !afterDataset.headers.includes(header)),
    },
    rows,
  };
}

function reportUnits(value) {
  return BigInt(value.replace('.', ''));
}

/**
 * Exact gross movement for a report. Matched changes are split into increases and
 * decreases so offsetting edits stay visible, and the largest absolute differences
 * are compared with the sum of every absolute difference (not the net change).
 */
export function summarizeMovement(report, top = 3) {
  const increased = { count: 0, units: 0n };
  const decreased = { count: 0, units: 0n };
  const magnitudes = [];
  let gross = 0n;
  for (const row of report.rows) {
    const delta = reportUnits(row.delta);
    const magnitude = delta < 0n ? -delta : delta;
    if (magnitude === 0n) continue;
    gross += magnitude;
    magnitudes.push(magnitude);
    if (row.status === 'changed') {
      const side = delta > 0n ? increased : decreased;
      side.count += 1;
      side.units += delta;
    }
  }
  magnitudes.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const count = Math.min(top, magnitudes.length);
  const largest = magnitudes.slice(0, count).reduce((sum, magnitude) => sum + magnitude, 0n);
  // Round down so a share is never overstated, e.g. 99.97% is shown as 99.9%.
  const tenths = gross === 0n ? null : (largest * 1000n) / gross;
  return {
    increased: { count: increased.count, total: formatDecimal(increased.units, report.scale) },
    decreased: { count: decreased.count, total: formatDecimal(decreased.units, report.scale) },
    gross: formatDecimal(gross, report.scale),
    moving: magnitudes.length,
    largest: { count, total: formatDecimal(largest, report.scale), percent: tenths === null ? null : `${tenths / 10n}.${tenths % 10n}` },
  };
}

function looseKeyPart(part) {
  return part.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * Pair removed and added keys that differ only by letter case, repeated or
 * surrounding whitespace, or Unicode compatibility forms such as full-width
 * letters. Matching itself stays exact; this only flags likely source typos.
 */
export function findSimilarKeys(report, limit = 3) {
  const result = { count: 0, examples: [] };
  const removed = new Map();
  for (const row of report.rows) {
    if (row.status !== 'removed') continue;
    const loose = JSON.stringify(row.key.map(looseKeyPart));
    if (!removed.has(loose)) removed.set(loose, row);
  }
  if (!removed.size) return result;
  for (const row of report.rows) {
    if (row.status !== 'added') continue;
    const match = removed.get(JSON.stringify(row.key.map(looseKeyPart)));
    if (!match) continue;
    result.count += 1;
    if (result.examples.length < limit) result.examples.push({ removed: [...match.key], added: [...row.key] });
  }
  return result;
}
