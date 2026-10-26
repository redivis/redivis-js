// The data that the integration tests upload, and what they expect to read back.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Temporal } from 'temporal-polyfill';

export const TINY_CSV = fileURLToPath(new URL('../data/tiny.csv', import.meta.url));

// The variables of tiny.csv, and their types as Redivis infers them
export const TINY_VARIABLE_TYPES = {
	id: 'integer',
	Numeric: 'integer',
	Key: 'string',
	Timestamp: 'string',
	Year: 'integer',
	Boolean: 'boolean',
	Text: 'string',
};

/**
 * The rows of tiny.csv, as Redivis should read them (with toRowsArray's defaults), sorted by id.
 * @returns {Record<string, any>[]}
 */
export function tinyRows() {
	const [header, ...lines] = readFileSync(TINY_CSV, 'utf8').trimEnd().split('\n');
	const names = header.split(',');
	// The file has no quoted values, so it can be split on commas
	return lines.map((line) =>
		Object.fromEntries(
			line.split(',').map((value, i) => {
				const type = TINY_VARIABLE_TYPES[names[i]];
				return [names[i], type === 'integer' ? Number(value) : type === 'boolean' ? value === 'true' : value];
			}),
		),
	);
}

/**
 * Rows with a column of each scalar type that Redivis supports, including nulls, a large integer, and the sorts of
 * strings that trip up parsers. They're uploaded as newline-delimited JSON, from which Redivis infers the types.
 */
export function typedRows() {
	const { PlainDate, PlainDateTime, PlainTime } = Temporal;
	const columns = {
		id: [1, 2, 3, 4, 5],
		// Beyond Number.MAX_SAFE_INTEGER, so only exact as a BigInt
		big_int_col: [9007199254740993n, -1n, null, 0n, 42n],
		float_col: [1.5, -2.25, null, 0.0, 1e10],
		string_col: ['plain', 'with, comma', 'with "quotes"', 'multi\nline', null],
		unicode_col: ['héllo', '日本語', 'emoji 🎉', 'tab\there', null],
		bool_col: [true, false, null, true, false],
		date_col: [
			PlainDate.from('2020-01-01'),
			PlainDate.from('1999-12-31'),
			null,
			PlainDate.from('2024-02-29'),
			PlainDate.from('1970-01-01'),
		],
		datetime_col: [
			PlainDateTime.from('2020-01-01T12:30:15.123456'),
			PlainDateTime.from('1999-12-31T23:59:59'),
			PlainDateTime.from('2024-02-29T00:00:00'),
			null,
			PlainDateTime.from('1970-01-01T00:00:00'),
		],
		time_col: [
			PlainTime.from('12:30:15'),
			PlainTime.from('00:00:00'),
			PlainTime.from('23:59:59.5'),
			null,
			PlainTime.from('08:00:00'),
		],
	};
	return columns.id.map((_, i) =>
		Object.fromEntries(Object.entries(columns).map(([name, values]) => [name, values[i]])),
	);
}

// The Redivis type of each column of typedRows()
export const TYPED_VARIABLE_TYPES = {
	id: 'integer',
	big_int_col: 'integer',
	float_col: 'float',
	string_col: 'string',
	unicode_col: 'string',
	bool_col: 'boolean',
	date_col: 'date',
	datetime_col: 'dateTime',
	time_col: 'time',
};

export const GEO_FEATURES = [
	{ name: 'point', value: 1, geometry: { type: 'Point', coordinates: [-122.17, 37.43] } },
	{
		name: 'line',
		value: 2,
		geometry: {
			type: 'LineString',
			coordinates: [
				[-122.0, 37.0],
				[-121.0, 38.0],
			],
		},
	},
	{
		name: 'polygon',
		value: 3,
		geometry: {
			type: 'Polygon',
			coordinates: [
				[
					[-122.0, 37.0],
					[-121.0, 37.0],
					[-121.0, 38.0],
					[-122.0, 37.0],
				],
			],
		},
	},
];

export function geojsonBytes() {
	return new TextEncoder().encode(
		JSON.stringify({
			type: 'FeatureCollection',
			features: GEO_FEATURES.map(({ name, value, geometry }) => ({
				type: 'Feature',
				geometry,
				properties: { name, value },
			})),
		}),
	);
}

/**
 * The files uploaded to the file index table, by path.
 * @returns {Record<string, Uint8Array>}
 */
export function rawFiles() {
	const encode = (text) => new TextEncoder().encode(text);
	return {
		'readme.txt': encode('A file for testing.\nIt has a few lines,\nincluding ünïcödé.\n'),
		'data/numbers.csv': encode(Array.from({ length: 1000 }, (_, i) => `${i},${i * i}\n`).join('')),
		// Large enough to need several reads when streamed
		'data/nested/random.bin': pseudoRandomBytes(3 * 2 ** 20),
		'with space & symbols.txt': encode('named awkwardly'),
	};
}

// Deterministic bytes that don't compress, so the file can't be served in fewer chunks than its size suggests
export function pseudoRandomBytes(length, seed = 'redivis') {
	const bytes = new Uint8Array(length);
	for (let offset = 0, counter = 0; offset < length; offset += 32, counter++) {
		const block = createHash('sha256').update(`${seed}:${counter}`).digest();
		bytes.set(block.subarray(0, Math.min(32, length - offset)), offset);
	}
	return bytes;
}

export async function writeFiles(directory, files) {
	for (const [path, content] of Object.entries(files)) {
		const filePath = join(directory, path);
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, content);
	}
	return directory;
}

export function md5Base64(content) {
	return createHash('md5').update(content).digest('base64');
}

// A CSV of the given number of rows, of an id and some text
export function largeCsv(numRows) {
	const lines = ['id,text'];
	for (let i = 0; i < numRows; i++) {
		lines.push(`${i},row number ${i} of the large upload`);
	}
	return new TextEncoder().encode(`${lines.join('\n')}\n`);
}

export const SMALL_CSV = 'id,name,value\n1,a,1.5\n2,b,2.5\n3,c,\n';

/**
 * Rows come back in no particular order, so compare them sorted.
 * @template T
 * @param {T[]} rows
 * @param {string} [key]
 * @returns {T[]}
 */
export function sortedBy(rows, key = 'id') {
	return [...rows].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
}

/**
 * The rows of a CSV file, keyed by the header row, with each value as a string. Values may be quoted, with quotes
 * escaped by doubling them, and contain commas and newlines.
 * @param {string} text
 * @returns {Record<string, string>[]}
 */
export function parseCsv(text) {
	const records = [];
	let record = [];
	let value = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (quoted) {
			if (char === '"' && text[i + 1] === '"') {
				value += '"';
				i++;
			} else if (char === '"') {
				quoted = false;
			} else {
				value += char;
			}
		} else if (char === '"') {
			quoted = true;
		} else if (char === ',') {
			record.push(value);
			value = '';
		} else if (char === '\n') {
			records.push([...record, value]);
			record = [];
			value = '';
		} else if (char !== '\r') {
			value += char;
		}
	}
	if (value || record.length) {
		records.push([...record, value]);
	}
	const [names, ...rows] = records;
	return rows.map((row) => Object.fromEntries(row.map((v, i) => [names[i], v])));
}

// Picks some properties of each row
export function pick(rows, keys) {
	return rows.map((row) => Object.fromEntries(keys.map((key) => [key, row[key]])));
}
