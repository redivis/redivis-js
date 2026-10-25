import Base from './Base.js';
import { sleep } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { JobError, ValueError } from '../common/errors.js';
import { downloadFiles, expandHome } from '../common/download.js';
import { importNodeModule, requireNode } from '../common/node.js';

export default class Export extends Base {
	/**
	 * An export of a table, query, or upload's data to files, as created by their `download()` method.
	 *
	 * @param {[id: string, options?: {fileName?: string, properties?: Record<string, any>}] | [options: {id: string, fileName?: string, properties?: Record<string, any>}]} args
	 *   `fileName` is the name of the downloaded file (or directory, if there are several)
	 */
	constructor(...args) {
		super();
		const { id, fileName, properties } = parseArgs(args, ['id'], {
			defaults: { fileName: 'export' },
			allowed: ['properties'],
		});
		/** @type {string} */
		this.id = id;
		/** @type {string} */
		this.fileName = fileName;
		this.properties = properties;
		this.uri = properties?.uri ?? `/exports/${encodeURIComponent(id)}`;
	}

	toString() {
		return `<Export ${this.id}>`;
	}

	/**
	 * Waits for the export to finish, throwing a JobError if it fails.
	 *
	 * @param {[options?: {onProgress?: (progress: {percentCompleted: number}) => void, signal?: AbortSignal}]} args
	 * @returns {Promise<this>}
	 */
	async waitForFinish(...args) {
		const { onProgress, signal } = parseArgs(args, [], { allowed: ['onProgress', 'signal'] });
		for (let iteration = 1; ; iteration++) {
			const { status, percentCompleted, errorMessage, kind } = this.properties ?? {};
			if (status === 'completed') {
				return this;
			} else if (status === 'failed' || status === 'cancelled') {
				throw new JobError({ message: errorMessage, status, kind: kind ?? 'export' });
			}
			if (percentCompleted !== undefined) {
				onProgress?.({ percentCompleted });
			}
			await sleep(Math.min(iteration * 500, 2000), signal);
			await this.get();
		}
	}

	/**
	 * Waits for the export to finish, then downloads its files (in Node only).
	 *
	 * @param {[path?: string, options?: Omit<import('./TabularReader.js').DataDownloadOptions, 'format'>] | [options?: Omit<import('./TabularReader.js').DataDownloadOptions, 'format'> & {path?: string}]} args
	 *   A file path, if the export is a single file; otherwise (or if it's an existing directory, or ends with a
	 *   separator) the directory to download into. Defaults to the current working directory.
	 * @returns {Promise<string[]>} The paths of the downloaded files
	 */
	async downloadFiles(...args) {
		let { path, overwrite, maxConcurrency, onProgress, signal } = parseArgs(args, ['path'], {
			defaults: { overwrite: false, maxConcurrency: 16 },
			allowed: ['onProgress', 'signal'],
		});
		requireNode('Downloading files');
		await this.waitForFinish({
			signal,
			onProgress: (progress) => onProgress?.({ stage: 'exporting', ...progress }),
		});
		const { fileCount, format } = this.properties;
		const files = Array.from({ length: fileCount }, (_, filePart) => ({
			uri: `${this.uri}/download`,
			query: { filePart },
			relativePath:
				fileCount === 1 ? `${this.fileName}.${format}` : `${String(filePart).padStart(6, '0')}.${format}`,
		}));
		const options = {
			overwrite,
			maxConcurrency,
			signal,
			onProgress: (progress) => onProgress?.({ stage: 'downloading', ...progress }),
		};

		const [nodePath, os, { stat }] = await Promise.all([
			importNodeModule('path'),
			importNodeModule('os'),
			importNodeModule('fs/promises'),
		]);
		if (typeof path === 'string') {
			path = expandHome(path, os);
		}
		const stats = path === undefined || path === null ? null : await stat(path).catch(() => null);
		if (path === undefined || path === null || stats?.isDirectory()) {
			// Multiple files are downloaded into a directory of their own
			const directory = path ?? '.';
			return downloadFiles(files, {
				...options,
				path: fileCount > 1 ? nodePath.join(directory, this.fileName) : directory,
			});
		} else if (/[\\/]$/.test(path) || (!stats && !nodePath.basename(path).includes('.'))) {
			// A path that doesn't exist is treated as a directory if it doesn't have a file extension
			return downloadFiles(files, { ...options, path });
		} else if (fileCount > 1) {
			throw new ValueError(
				`"${path}" is a file path, but the export consists of ${fileCount} files. Specify a directory instead.`,
			);
		}
		return downloadFiles([{ ...files[0], relativePath: nodePath.basename(path) }], {
			...options,
			path: nodePath.dirname(path),
		});
	}
}
