import { isPlainObject } from './args.js';
import { ValueError } from './errors.js';
import { importNodeModule, requireNode } from './node.js';
import { jsonReplacer } from './json.js';
import { toRowsArray } from './rowsArray.js';
import { Table as ArrowTable } from 'apache-arrow';

/**
 * Normalizes the content of an upload or file to `{ source, size, name, type }`, where `source.read(start, end)` reads
 * a range of its bytes, and `source.rereadable` is whether any range can be read again (which a stream's can't).
 *
 * Accepts a Blob or File; an ArrayBuffer or typed array; a ReadableStream (with `size`); a file path (in Node); or
 * tabular data (an array of row objects, or an arrow Table), which is serialized as newline-delimited JSON.
 */
export async function resolveContent(content, { size, name } = {}) {
	if (typeof content === 'string') {
		requireNode('Uploading from a file path');
		const [{ openAsBlob }, path] = await Promise.all([importNodeModule('fs'), importNodeModule('path')]);
		const blob = await openAsBlob(content);
		return { source: blobSource(blob), size: blob.size, name: name ?? path.basename(content) };
	}
	if (typeof Blob !== 'undefined' && content instanceof Blob) {
		return { source: blobSource(content), size: content.size, name: name ?? content.name };
	}
	if (content instanceof ArrayBuffer || ArrayBuffer.isView(content)) {
		const blob = new Blob([content]);
		return { source: blobSource(blob), size: blob.size, name };
	}
	if (content instanceof ReadableStream) {
		if (!Number.isInteger(size) || size < 0) {
			throw new ValueError('The size of a ReadableStream must be provided, with the `size` option');
		}
		return { source: streamSource(content, size), size, name };
	}
	if (Array.isArray(content) || content instanceof ArrowTable) {
		const blob = await toNdjsonBlob(content);
		return { source: blobSource(blob), size: blob.size, name, type: 'jsonl' };
	}
	throw new ValueError(
		'Content must be a Blob, File, ArrayBuffer, typed array, ReadableStream, file path (in Node), array of row ' +
			'objects, or arrow Table',
	);
}

// Serializes rows (or an arrow Table) as newline-delimited JSON
async function toNdjsonBlob(data) {
	const rows = data instanceof ArrowTable ? await toRowsArray(data, { bigInt: true }) : data;
	const lines = rows.map((row, i) => {
		if (!isPlainObject(row)) {
			throw new ValueError(`Each row must be an object, but row ${i} is ${row === null ? 'null' : typeof row}`);
		}
		return JSON.stringify(row, jsonReplacer);
	});
	return new Blob([lines.join('\n')], { type: 'application/x-ndjson' });
}

function blobSource(blob) {
	return { read: async (start, end) => blob.slice(start, end), rereadable: true };
}

// Reads a stream as consecutive ranges. Data before the most recent range is discarded, but the current range is kept,
//   so that it can be read again if uploading it fails (GCS never asks for bytes before the last range it acknowledged).
function streamSource(stream, size) {
	const reader = stream.getReader();
	let buffer = new Uint8Array(0);
	let bufferStart = 0;

	return {
		rereadable: false,
		async read(start, end) {
			if (start < bufferStart) {
				throw new ValueError("Can't re-read data that was already discarded from the stream");
			}
			buffer = buffer.subarray(start - bufferStart);
			bufferStart = start;
			while (bufferStart + buffer.length < end) {
				const { done, value } = await reader.read();
				if (done) {
					throw new ValueError(
						`The stream ended after ${bufferStart + buffer.length} bytes, before its size (${size})`,
					);
				}
				const combined = new Uint8Array(buffer.length + value.length);
				combined.set(buffer);
				combined.set(value, buffer.length);
				buffer = combined;
			}
			return buffer.slice(0, end - start);
		},
	};
}

// Resolves the files to add to a file index table, from a local directory (in Node) or a list of file specifications
export async function resolveFiles({ files, directory }) {
	if ((files === undefined) === (directory === undefined)) {
		throw new ValueError('Exactly one of `files` or `directory` must be provided');
	}
	if (directory !== undefined) {
		requireNode('Uploading a directory');
		const { readdir } = await importNodeModule('fs/promises');
		const path = await importNodeModule('path');
		const entries = await readdir(directory, { recursive: true, withFileTypes: true });
		const filePaths = entries
			.filter((entry) => entry.isFile())
			.map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
			// Like a shell glob, skip hidden files and directories (e.g., .DS_Store)
			.filter(
				(filePath) =>
					!path
						.relative(directory, filePath)
						.split(path.sep)
						.some((part) => part.startsWith('.')),
			)
			.sort();
		return Promise.all(
			filePaths.map(async (filePath) => ({
				...(await resolveContent(filePath)),
				name: path.relative(directory, filePath).split(path.sep).join('/'),
			})),
		);
	}

	if (!Array.isArray(files) && !(typeof FileList !== 'undefined' && files instanceof FileList)) {
		throw new ValueError('`files` must be an array');
	}
	return Promise.all(
		[...files].map(async (file) => {
			if (typeof file === 'string') {
				return resolveContent(file);
			}
			if (typeof File !== 'undefined' && file instanceof File) {
				// Files picked from a directory keep their path within it
				return resolveContent(file, { name: file.webkitRelativePath || file.name });
			}
			if (isPlainObject(file)) {
				const { path, data, name } = file;
				if (path !== undefined) {
					return resolveContent(path, { name });
				}
				if (!name) {
					throw new ValueError('Every file specified with `data` must also have a `name`');
				}
				return resolveContent(typeof data === 'string' ? new TextEncoder().encode(data) : data, { name });
			}
			const resolved = await resolveContent(file);
			if (!resolved.name) {
				throw new ValueError('Every file must have a name; pass { name, data } for content without one');
			}
			return resolved;
		}),
	);
}
