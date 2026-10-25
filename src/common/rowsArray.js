import { Type } from 'apache-arrow';
import { floorDiv } from './arrowTypes.js';

const MICROS_PER_MILLI = 1000n;

let temporalPromise;

// Uses the native Temporal API where it's available, and otherwise loads a polyfill (without installing it globally)
export function loadTemporal() {
	if (globalThis.Temporal) {
		return Promise.resolve(globalThis.Temporal);
	}
	temporalPromise ??= import('temporal-polyfill').then(({ Temporal }) => Temporal);
	return temporalPromise;
}

/**
 * Converts an arrow Table (as read by readTable) to an array of plain row objects.
 *
 * @param {import('apache-arrow').Table} table
 * @param {object} options
 * @param {boolean} [options.bigInt=false] Return integers as BigInts, rather than (possibly lossy) Numbers
 * @param {boolean} [options.temporal=true] Return dates, dateTimes, and times as Temporal.PlainDate,
 *   Temporal.PlainDateTime, and Temporal.PlainTime, rather than as Dates (for dates and dateTimes) and strings (times)
 * @returns {Promise<object[]>}
 */
export async function toRowsArray(table, { bigInt = false, temporal = true } = {}) {
	const fields = table.schema.fields;
	const needsTemporal =
		temporal && fields.some(({ type }) => [Type.Date, Type.Timestamp, Type.Time].includes(type.typeId));
	const Temporal = needsTemporal ? await loadTemporal() : null;

	const columns = fields.map((field, i) => columnValues(table.getChildAt(i), { bigInt, Temporal }));
	const rows = new Array(table.numRows);
	for (let row = 0; row < rows.length; row++) {
		const object = {};
		for (let column = 0; column < fields.length; column++) {
			object[fields[column].name] = columns[column][row];
		}
		rows[row] = object;
	}
	return rows;
}

function columnValues(vector, { bigInt, Temporal }) {
	const convert = getConverter(vector.type, { bigInt, Temporal });
	const values = new Array(vector.length);
	let index = 0;
	for (const data of vector.data) {
		for (let i = 0; i < data.length; i++, index++) {
			values[index] = data.getValid(i) ? convert(data, i, vector, index) : null;
		}
	}
	return values;
}

// Returns a function of (data, indexInData, vector, indexInVector) that returns the converted value
function getConverter(type, { bigInt, Temporal }) {
	switch (type.typeId) {
		case Type.Int:
			return (data, i) => (bigInt ? BigInt(data.values[i]) : Number(data.values[i]));
		case Type.Date:
			return (data, i, vector, index) => {
				const date = new Date(vector.get(index));
				return Temporal
					? new Temporal.PlainDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
					: date;
			};
		case Type.Timestamp:
			// The reader always conforms timestamps to microseconds, which arrow-js returns as lossy numbers
			return (data, i) => {
				const micros = data.values[i];
				const millis = floorDiv(micros, MICROS_PER_MILLI);
				const date = new Date(Number(millis));
				if (!Temporal) {
					return date;
				}
				return new Temporal.PlainDateTime(
					date.getUTCFullYear(),
					date.getUTCMonth() + 1,
					date.getUTCDate(),
					date.getUTCHours(),
					date.getUTCMinutes(),
					date.getUTCSeconds(),
					date.getUTCMilliseconds(),
					Number(micros - millis * MICROS_PER_MILLI),
				);
			};
		case Type.Time:
			return (data, i) => {
				const micros = Number(data.values[i]);
				const parts = [
					Math.floor(micros / 3_600_000_000),
					Math.floor(micros / 60_000_000) % 60,
					Math.floor(micros / 1_000_000) % 60,
					micros % 1_000_000,
				];
				if (Temporal) {
					const [hours, minutes, seconds, fraction] = parts;
					return new Temporal.PlainTime(
						hours,
						minutes,
						seconds,
						Math.floor(fraction / 1000),
						fraction % 1000,
					);
				}
				return formatTime(parts);
			};
		default:
			return (data, i, vector, index) => vector.get(index);
	}
}

// HH:MM:SS, with microseconds when there are any
function formatTime([hours, minutes, seconds, fraction]) {
	const pad = (value, length = 2) => String(value).padStart(length, '0');
	return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${fraction ? `.${pad(fraction, 6)}` : ''}`;
}
