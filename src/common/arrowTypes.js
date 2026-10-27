import {
	Bool,
	DateDay,
	Field,
	Float64,
	Int64,
	Schema,
	TimeMicrosecond,
	TimestampMicrosecond,
	TimeUnit,
	Type,
	Utf8,
	makeData,
	util,
	vectorFromArray,
} from 'apache-arrow';
import { ValueError } from './errors.js';

const MICROS_PER_DAY = 86_400_000_000n;

// The arrow type that each Redivis variable type is read as
export function variableToArrowType(type) {
	switch (type) {
		case 'integer':
			return new Int64();
		case 'float':
			return new Float64();
		case 'boolean':
			return new Bool();
		case 'date':
			return new DateDay();
		case 'dateTime':
			return new TimestampMicrosecond();
		case 'time':
			return new TimeMicrosecond();
		default:
			// string, geography (as WKT)
			return new Utf8();
	}
}

export function variablesToSchema(variables) {
	return new Schema(variables.map(({ name, type }) => new Field(name, variableToArrowType(type), true)));
}

export function typesEqual(a, b) {
	return util.compareTypes(a, b);
}

// Returns null data of the given type
export function makeNullData(type, length) {
	if (type.typeId === Type.Utf8) {
		return vectorFromArray(new Array(length).fill(null), type).data[0];
	}
	return makeData({ type, length, nullCount: length, nullBitmap: new Uint8Array(Math.ceil(length / 8)) });
}

// Converts a column to the given type. Some dataset tables are stored with a different physical type than their
//   variables' (e.g., a dateTime stored as a string), and arrow-js has no cast kernels, so values are converted one by
//   one. Throws a ValueError if a value can't be converted.
export function coerceVector(vector, targetType, variableName) {
	const length = vector.length;
	const source = readValues(vector);

	if (targetType.typeId === Type.Utf8) {
		const toString = getStringConverter(vector.type);
		return vectorFromArray(
			source.map((value) => (value === null ? null : toString(value))),
			targetType,
		).data[0];
	}

	const convert = getConverter(targetType, vector.type);
	const ArrayType = targetType.typeId === Type.Bool ? Array : targetType.ArrayType;
	const values = new ArrayType(length);
	const nullBitmap = new Uint8Array(Math.ceil(length / 8));
	let nullCount = 0;

	for (let i = 0; i < length; i++) {
		let converted = null;
		// An empty string can only mean a missing value for any non-string type
		if (source[i] !== null && !(typeof source[i] === 'string' && !source[i].trim())) {
			try {
				converted = convert(source[i]);
			} catch (e) {
				converted = undefined;
			}
			if (converted === undefined) {
				throw new ValueError(
					`Couldn't convert the value ${JSON.stringify(String(source[i]))} of variable "${variableName}" to ${targetType}`,
				);
			}
		}
		if (converted === null) {
			nullCount++;
		} else {
			nullBitmap[i >> 3] |= 1 << (i & 7);
			values[i] = converted;
		}
	}

	if (targetType.typeId === Type.Bool) {
		return vectorFromArray(
			values.map((value, i) => (nullBitmap[i >> 3] & (1 << (i & 7)) ? value : null)),
			targetType,
		).data[0];
	}
	return makeData({ type: targetType, length, nullCount, nullBitmap, data: values });
}

// The values of a column, where timestamps and times are in their native units, as bigints (rather than the lossy
//   millisecond numbers that arrow-js returns for timestamps)
function readValues(vector) {
	const values = [];
	for (const data of vector.data) {
		const isFixedTemporal = data.type.typeId === Type.Timestamp || data.type.typeId === Type.Time;
		for (let i = 0; i < data.length; i++) {
			if (!data.getValid(i)) {
				values.push(null);
			} else if (isFixedTemporal && data.values instanceof BigInt64Array) {
				values.push(data.values[i]);
			} else {
				values.push(vector.get(values.length));
			}
		}
	}
	return values;
}

// Converts values to strings as BigQuery casts them (e.g., when a variable's type was relaxed to string because its
//   uploads disagreed), rather than as the epoch numbers that arrow-js reads temporal values as
function getStringConverter(sourceType) {
	switch (sourceType.typeId) {
		case Type.Date:
			return (value) => formatDateTime(toMicros(value, sourceType), { includeTime: false });
		case Type.Timestamp:
			return (value) => formatDateTime(toMicros(value, sourceType), { includeTime: true });
		case Type.Time:
			return (value) => formatTime(toTimeMicros(value, sourceType));
		default:
			return String;
	}
}

// Formats microseconds since the epoch as "2020-01-02" or "2020-01-02 03:04:05[.fraction]"
function formatDateTime(micros, { includeTime }) {
	const days = floorDiv(micros, MICROS_PER_DAY);
	const date = new Date(Number(days) * 86_400_000);
	const formattedDate = `${String(date.getUTCFullYear()).padStart(4, '0')}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
	return includeTime ? `${formattedDate} ${formatTime(micros - days * MICROS_PER_DAY)}` : formattedDate;
}

// Formats microseconds since midnight as "03:04:05", with any fraction of a second in milliseconds if that's exact,
//   or else microseconds (".500", ".123456")
function formatTime(micros) {
	const seconds = micros / 1_000_000n;
	const fraction = micros % 1_000_000n;
	const formatted = `${pad(seconds / 3600n)}:${pad((seconds / 60n) % 60n)}:${pad(seconds % 60n)}`;
	if (!fraction) {
		return formatted;
	}
	return fraction % 1000n
		? `${formatted}.${String(fraction).padStart(6, '0')}`
		: `${formatted}.${String(fraction / 1000n).padStart(3, '0')}`;
}

function pad(value) {
	return String(value).padStart(2, '0');
}

function getConverter(targetType, sourceType) {
	switch (targetType.typeId) {
		case Type.Int:
			return toBigInt;
		case Type.Float:
			return (value) => {
				const number = Number(value);
				return Number.isNaN(number) && !/^\s*nan\s*$/i.test(value) ? undefined : number;
			};
		case Type.Bool:
			return toBoolean;
		case Type.Date:
			return (value) => {
				const micros = toMicros(value, sourceType);
				return micros === undefined ? undefined : Number(floorDiv(micros, MICROS_PER_DAY));
			};
		case Type.Timestamp:
			return (value) => toMicros(value, sourceType);
		case Type.Time:
			return (value) => toTimeMicros(value, sourceType);
		default:
			throw new ValueError(`Unsupported type ${targetType}`);
	}
}

function toBigInt(value) {
	if (typeof value === 'bigint') return value;
	if (typeof value === 'boolean') return value ? 1n : 0n;
	if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : undefined;
	const string = String(value).trim();
	if (/^[+-]?\d+$/.test(string)) return BigInt(string);
	const number = Number(string);
	return Number.isInteger(number) ? BigInt(number) : undefined;
}

function toBoolean(value) {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number' || typeof value === 'bigint') return value != 0;
	const string = String(value).trim().toLowerCase();
	if (string === 'true' || string === '1') return true;
	if (string === 'false' || string === '0') return false;
	return undefined;
}

// Microseconds since the epoch, for a date or dateTime value
function toMicros(value, sourceType) {
	if (typeof value === 'string') {
		return parseDateTime(value);
	}
	if (typeof value === 'bigint' && sourceType.typeId === Type.Timestamp) {
		return scaleToMicros(value, sourceType.unit);
	}
	if (typeof value === 'number') {
		// arrow-js returns dates (and non-bigint timestamps) as epoch milliseconds
		return BigInt(Math.round(value * 1000));
	}
	if (value instanceof Date) {
		return BigInt(value.getTime()) * 1000n;
	}
	return undefined;
}

// Microseconds since midnight, for a time value
function toTimeMicros(value, sourceType) {
	if (typeof value === 'string') {
		const match = value.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/);
		if (!match) return undefined;
		const [, hours, minutes, seconds = '0', fraction = ''] = match;
		return (
			BigInt((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1_000_000n +
			BigInt(fraction.padEnd(6, '0').slice(0, 6))
		);
	}
	if (sourceType.typeId === Type.Time) {
		return scaleToMicros(BigInt(value), sourceType.unit);
	}
	return undefined;
}

export function scaleToMicros(value, unit) {
	switch (unit) {
		case TimeUnit.SECOND:
			return value * 1_000_000n;
		case TimeUnit.MILLISECOND:
			return value * 1000n;
		case TimeUnit.NANOSECOND:
			return floorDiv(value, 1000n);
		default:
			return value;
	}
}

// Parses an ISO-ish date or dateTime ("2020-01-02", "2020-01-02 03:04:05.123456", "2020-01-02T03:04:05Z") to
//   microseconds since the epoch. Values without an offset are treated as UTC, since dateTimes have no time zone.
export function parseDateTime(string) {
	const match = string
		.trim()
		.match(
			/^([+-]?\d{4,6})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|UTC|[+-]\d{2}(?::?\d{2})?)?$/i,
		);
	if (!match) return undefined;
	const [, year, month, day, hours = 0, minutes = 0, seconds = 0, fraction = '', offset] = match;

	let millis = utcMillis(Number(year), Number(month), Number(day), Number(hours), Number(minutes), Number(seconds));
	if (offset && !/^(z|utc)$/i.test(offset)) {
		const [, sign, offsetHours, offsetMinutes = '0'] = offset.match(/^([+-])(\d{2}):?(\d{2})?$/);
		millis -= (sign === '-' ? -1 : 1) * (Number(offsetHours) * 60 + Number(offsetMinutes)) * 60_000;
	}
	return BigInt(millis) * 1000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
}

// Unlike Date.UTC, handles years 0-99 literally
export function utcMillis(year, month, day, hours = 0, minutes = 0, seconds = 0, millis = 0) {
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	date.setUTCHours(hours, minutes, seconds, millis);
	return date.getTime();
}

export function floorDiv(a, b) {
	const quotient = a / b;
	return a % b !== 0n && a < 0n !== b < 0n ? quotient - 1n : quotient;
}
