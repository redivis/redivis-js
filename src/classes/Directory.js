import File from './File.js';
import { parseArgs } from '../common/args.js';
import { ValueError } from '../common/errors.js';
import { downloadFiles } from '../common/download.js';

export default class Directory {
	/**
	 * A directory of files, built from a table's (or query's) file listing by `toDirectory()`.
	 *
	 * @param {object} options
	 * @param {string} [options.path='/'] The directory's absolute path, e.g. `/images`
	 * @param {import('./Table.js').default} [options.table]
	 * @param {import('./Query.js').default} [options.query]
	 * @param {Directory} [options.parent]
	 */
	constructor(...args) {
		const {
			path = '/',
			table,
			query,
			parent,
		} = parseArgs(args, [], {
			allowed: ['path', 'table', 'query', 'parent'],
		});
		if (!table && !query) {
			throw new ValueError('A directory must belong to a table or query');
		}
		this.path = path;
		this.name = path.split('/').pop();
		this.table = table;
		this.query = query;
		this.parent = parent;
		/** @type {Map<string, Directory|File>} */
		this.children = new Map();
	}

	toString() {
		return `<Directory ${this.path}>`;
	}

	/**
	 * Lists the directory's files and subdirectories.
	 *
	 * @param {number} [maxResults]
	 * @param {object} [options]
	 * @param {'all'|'files'|'directories'} [options.mode='all']
	 * @param {boolean} [options.recursive=false] Also list the contents of subdirectories
	 * @returns {Array<Directory|File>}
	 */
	list(...args) {
		const { maxResults, mode, recursive } = parseArgs(args, ['maxResults'], {
			defaults: { mode: 'all', recursive: false },
		});
		if (!['all', 'files', 'directories'].includes(mode)) {
			throw new ValueError('mode must be one of "all", "files", or "directories"');
		}
		const limit = maxResults ?? Number.POSITIVE_INFINITY;
		const results = [];
		for (const child of this.children.values()) {
			if (results.length >= limit) break;
			const isDirectory = child instanceof Directory;
			if (mode === 'all' || (mode === 'files') !== isDirectory) {
				results.push(child);
			}
			if (recursive && isDirectory && results.length < limit) {
				results.push(...child.list(limit - results.length, { mode, recursive }));
			}
		}
		return results.slice(0, limit);
	}

	/**
	 * Returns the file or directory at a path, relative to this directory (or absolute, from the root). A trailing
	 * slash only matches a directory.
	 *
	 * @param {string} path
	 * @returns {Directory|File|null}
	 */
	get(...args) {
		const { path } = parseArgs(args, ['path']);
		const mustBeDirectory = path.endsWith('/');
		let node = this;
		if (path.startsWith('/')) {
			while (node.parent) node = node.parent;
		}

		const parts = path.split('/').filter((part) => part && part !== '.');
		for (const [i, part] of parts.entries()) {
			const isLast = i === parts.length - 1;
			if (part === '..') {
				if (!node.parent) {
					throw new ValueError('The path traverses above the root directory');
				}
				node = node.parent;
				continue;
			}
			const child = node.children.get(part);
			if (!child) {
				return null;
			}
			if (child instanceof File) {
				return isLast && !mustBeDirectory ? child : null;
			}
			node = child;
		}
		return node;
	}

	/**
	 * Downloads the directory's files (in Node), recreating its structure. Files that already exist with the same
	 * contents are left as is.
	 *
	 * @param {string} [path] Defaults to a directory with this directory's name, in the current working directory
	 * @param {object} [options]
	 * @param {number} [options.maxResults] The maximum number of files to download
	 * @param {boolean} [options.overwrite=false] Replace existing files with different contents
	 * @param {number} [options.maxConcurrency=32] The number of files to download at once
	 * @param {(progress: {bytesDownloaded: number, totalBytes: number, filesDownloaded: number, totalFiles: number}) => void} [options.onProgress]
	 * @param {AbortSignal} [options.signal]
	 * @returns {Promise<string[]>} The paths of the downloaded files
	 */
	async download(...args) {
		const { path, maxResults, overwrite, maxConcurrency, onProgress, signal } = parseArgs(args, ['path'], {
			defaults: { overwrite: false, maxConcurrency: 32 },
			allowed: ['maxResults', 'onProgress', 'signal'],
		});
		const files = this.list(maxResults, { mode: 'files', recursive: true });
		const prefix = this.path === '/' ? '' : `${this.path.slice(1)}/`;
		return downloadFiles(
			files.map((file) => ({
				uri: file.uri,
				relativePath: file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path,
				size: file.size,
				md5Hash: file.md5Hash,
			})),
			{
				path,
				defaultDirectoryName: this.name || this.table?.name || 'files',
				overwrite,
				maxConcurrency,
				onProgress,
				signal,
			},
		);
	}

	_addFile(file, parts = file.path.split('/').filter(Boolean)) {
		if (parts.length === 1) {
			this.children.set(parts[0], file);
			file.directory = this;
			return;
		}
		let subdirectory = this.children.get(parts[0]);
		if (!(subdirectory instanceof Directory)) {
			subdirectory = new Directory({
				path: `${this.path === '/' ? '' : this.path}/${parts[0]}`,
				table: this.table,
				query: this.query,
				parent: this,
			});
			this.children.set(parts[0], subdirectory);
		}
		subdirectory._addFile(file, parts.slice(1));
	}
}
