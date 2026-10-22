/** Exact, dependency-free CSV reconciliation for Node.js and browsers. */

export const MAX_ROWS = 100_000;
export const MAX_TEXT_BYTES = 20 * 1024 * 1024;
export const MAX_DECIMAL_PLACES = 12;
export const MAX_INTEGER_DIGITS = 30;

function validateHeaders(headers, label) {
  if (!Array.isArray(headers) || headers.length === 0) {
    throw new Error(`${label} must contain a header row.`);
  }
  const seen = new Set();
  for (const header of headers) {
    if (typeof header !== 'string' || header.trim() === '') {
      throw new Error(`${label} contains an empty header.`);
    }
    if (seen.has(header)) throw new Error(`${label} contains duplicate header ${JSON.stringify(header)}.`);
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

function parseDecimal(value, label) {
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`${label} must be a decimal number without blanks, spaces, exponents, or grouping separators.`);
  }
  const negative = value.startsWith('-');
  const [integer, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  if (integer.length > MAX_INTEGER_DIGITS) throw new Error(`${label} exceeds the 30 integer digit limit.`);
  if (fraction.length > MAX_DECIMAL_PLACES) throw new Error(`${label} exceeds the 12 decimal place limit.`);
  const coefficient = BigInt(integer + fraction) * (negative ? -1n : 1n);
  return { coefficient, scale: fraction.length };
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
 * Nonmetric changes are intentionally ignored. Missing/duplicate/blank keys and
 * invalid numbers fail the entire operation rather than silently dropping rows.
 * All returned numbers use the largest input decimal scale. Removed totals are
 * signed contributions: removing a negative value contributes a positive delta.
 * Output order follows before rows, then newly added rows in their after order.
 */
export function reconcile(beforeDataset, afterDataset, options = {}) {
  const { keys = ['account'], value = 'amount', beforeName = 'before.csv', afterName = 'after.csv' } = options;
  if (!Array.isArray(keys) || keys.length === 0 || keys.some((key) => typeof key !== 'string' || key.trim() === '') || new Set(keys).size !== keys.length) {
    throw new Error('Choose one or more distinct, nonempty key columns.');
  }
  if (typeof value !== 'string' || value.trim() === '') throw new Error('Choose a nonempty value column.');
  if (typeof beforeName !== 'string' || typeof afterName !== 'string') throw new Error('Dataset names must be strings.');
  validateDataset(beforeDataset, 'Before CSV');
  validateDataset(afterDataset, 'After CSV');

  let scale = 0;
  const read = (dataset, label) => {
    for (const column of [...keys, value]) {
      if (!dataset.headers.includes(column)) throw new Error(`${label} is missing column ${JSON.stringify(column)}.`);
    }
    const keyIndices = keys.map((key) => dataset.headers.indexOf(key));
    const valueIndex = dataset.headers.indexOf(value);
    const records = new Map();
    for (let index = 0; index < dataset.rows.length; index += 1) {
      const row = dataset.rows[index];
      const key = keyIndices.map((column) => row[column]);
      if (key.some((part) => part.trim() === '')) throw new Error(`${label} record ${index + 2} has a blank key.`);
      const identity = JSON.stringify(key);
      if (records.has(identity)) throw new Error(`${label} record ${index + 2} has duplicate key ${identity}.`);
      const decimal = parseDecimal(row[valueIndex], `${label} record ${index + 2}, column ${JSON.stringify(value)}`);
      scale = Math.max(scale, decimal.scale);
      records.set(identity, { key, decimal });
    }
    return records;
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
