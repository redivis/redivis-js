import Base from './Base.js';
import Organization from './Organization.js';
import Query from './Query.js';
import Table from './Table.js';
import User from './User.js';
import Version from './Version.js';
import { makeRequest, makePaginatedRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { getConfigValue } from '../common/config.js';
import { waitForVersionFinalization } from '../common/jobs.js';
import { ValueError } from '../common/errors.js';
import { definedValues, splitReference } from '../common/references.js';

/** @typedef {import('../common/args.js').ListArgs} ListArgs */
/** @typedef {import('../common/args.js').NameArgs} NameArgs */

/**
 * @typedef {object} DatasetOptions
 * @property {string} [version] The version tag, e.g. `v1_0`, `current`, or `next`
 * @property {User | string} [user]
 * @property {Organization | string} [organization]
 * @property {Record<string, any>} [properties]
 */

/**
 * @typedef {object} DatasetUpdateOptions
 * @property {string} [name]
 * @property {'none' | 'overview' | 'metadata' | 'sample' | 'data'} [publicAccessLevel]
 * @property {string} [description]
 * @property {string} [methodologyMarkdown]
 * @property {string} [usageMarkdown]
 * @property {string[]} [labels] Replaces the dataset's labels
 * @property {string[]} [labelsToAdd]
 * @property {string[]} [labelsToRemove]
 * @property {string[]} [tags] Replaces the dataset's tags
 * @property {string[]} [tagsToAdd]
 * @property {string[]} [tagsToRemove]
 */

export default class Dataset extends Base {
	/**
	 * A dataset.
	 *
	 * @param {[name: string, options?: DatasetOptions] | [options: DatasetOptions & {name: string}]} args The dataset's
	 *   name, optionally with a reference id and version (`name:abc1:v1_0`). If no owner is given, this may be fully
	 *   qualified (`owner.name`), or else the owner is the configured `defaultUser` or `defaultOrganization`.
	 */
	constructor(...args) {
		super();
		let { name, version, user, organization, properties } = parseArgs(args, ['name'], {
			allowed: ['version', 'user', 'organization', 'properties'],
		});
		if (typeof user === 'string') user = new User(user);
		if (typeof organization === 'string') organization = new Organization(organization);

		if (!user && !organization) {
			const parts = splitReference(name);
			if (parts.length === 2) {
				// Whether the owner is a user or an organization is resolved once we know more about the dataset
				[user, organization] = [new User(parts[0]), new Organization(parts[0])];
				name = parts[1];
			} else if (getConfigValue('defaultUser')) {
				user = new User(getConfigValue('defaultUser'));
			} else if (getConfigValue('defaultOrganization')) {
				organization = new Organization(getConfigValue('defaultOrganization'));
			} else {
				throw new ValueError(
					`Invalid dataset reference "${name}". It must be fully qualified (owner.dataset) if no owner is specified.`,
				);
			}
		}

		/** @type {string} */
		this.name = name.split(':')[0];
		/** @type {User | undefined} */
		this.user = user;
		/** @type {Organization | undefined} */
		this.organization = organization;

		const referenceId = name.replace(/:(v\d+[._]\d+|current|next|sample)/gi, '').split(':')[1];
		if (!version) {
			version = name.match(/:(v\d+[._]\d+|current|next)/i)?.[1];
		}
		/** @type {string | undefined} */
		this.versionTag = normalizeVersionTag(version);

		/** @type {string} */
		this.scopedReference =
			properties?.scopedReference ??
			`${this.name}${referenceId ? `:${referenceId}` : ''}${this.versionTag ? `:${this.versionTag}` : ''}`;
		/** @type {string} */
		this.qualifiedReference =
			properties?.qualifiedReference ?? `${(this.organization || this.user).name}.${this.scopedReference}`;
		this.uri = properties?.uri ?? `/datasets/${encodeURIComponent(this.qualifiedReference)}`;
		this.properties = properties;
	}

	/**
	 * @param {NameArgs} args
	 * @returns {Table}
	 */
	table(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Table(name, { dataset: this });
	}

	/**
	 * Returns a query, in which unqualified table references resolve within this dataset.
	 *
	 * @param {[query: string] | [options: {query: string}]} args
	 * @returns {Query}
	 */
	query(...args) {
		const { query } = parseArgs(args, ['query']);
		return new Query(query, { defaultDataset: this.qualifiedReference });
	}

	/**
	 * Creates the dataset.
	 *
	 * @param {[options?: {publicAccessLevel?: 'none' | 'overview' | 'metadata' | 'sample' | 'data', description?: string}]} args
	 * @returns {Promise<this>}
	 */
	async create(...args) {
		const { publicAccessLevel, description } = parseArgs(args, [], {
			defaults: { publicAccessLevel: 'none' },
			allowed: ['description'],
		});
		await this._rectifyAmbiguousOwner();
		const path = this.organization ? `${this.organization.uri}/datasets` : `${this.user.uri}/datasets`;

		this._updateProperties(
			await makeRequest({
				method: 'POST',
				path,
				payload: { name: this.name, description, publicAccessLevel },
			}),
		);
		return this;
	}

	/**
	 * Updates the dataset's metadata. Only the options that are passed are changed.
	 *
	 * @param {[options: DatasetUpdateOptions]} args
	 * @returns {Promise<this>}
	 */
	async update(...args) {
		const options = parseArgs(args, [], {
			allowed: [
				'name',
				'publicAccessLevel',
				'description',
				'methodologyMarkdown',
				'usageMarkdown',
				'labels',
				'labelsToAdd',
				'labelsToRemove',
				'tags',
				'tagsToAdd',
				'tagsToRemove',
			],
		});
		this._updateProperties(await makeRequest({ method: 'PATCH', path: this.uri, payload: definedValues(options) }));
		return this;
	}

	/**
	 * Updates the metadata of many variables across the dataset's tables at once.
	 *
	 * @param {[variables: Record<string, any>[]] | [options: {variables: Record<string, any>[]}]} args
	 * @returns {Promise<void>}
	 */
	async updateVariables(...args) {
		const { variables } = parseArgs(args, ['variables']);
		await makeRequest({ method: 'PATCH', path: `${this.uri}/variables`, payload: { variables } });
	}

	/**
	 * Deletes the dataset.
	 * @returns {Promise<void>}
	 */
	async delete() {
		await makeRequest({ method: 'DELETE', path: this.uri });
	}

	/**
	 * Creates the next (unreleased) version of the dataset, where changes can be made before it's released.
	 *
	 * @param {[options?: {ifNotExists?: boolean}]} args With `ifNotExists`, return the existing next version, rather than
	 *   throwing, if there already is one
	 * @returns {Promise<Dataset>} The dataset at its next version
	 */
	async createNextVersion(...args) {
		const { ifNotExists } = parseArgs(args, [], { defaults: { ifNotExists: false } });
		if (!this.properties || !('nextVersion' in this.properties)) {
			await this.get();
		}
		if (!this.properties.nextVersion) {
			await makeRequest({ method: 'POST', path: `${this.uri}/versions` });
		} else if (!ifNotExists) {
			throw new ValueError(
				`Next version already exists at ${this.properties.nextVersion.datasetUri}. To avoid this error, set the ifNotExists option to true`,
			);
		}
		await this._rectifyAmbiguousOwner();
		return new Dataset(this.scopedReference, {
			user: this.user,
			organization: this.organization,
			version: 'next',
		}).get();
	}

	/**
	 * Releases the next version of the dataset.
	 *
	 * @param {[options?: {releaseNotes?: string, waitForFinalization?: boolean, signal?: AbortSignal}]} args With
	 *   `waitForFinalization`, wait until the release has been finalized, after which the dataset can be released,
	 *   unreleased, or deleted again. The signal stops waiting, but doesn't cancel the release.
	 * @returns {Promise<this>} This dataset, at the newly released version
	 */
	async release(...args) {
		const { releaseNotes, waitForFinalization, signal } = parseArgs(args, [], {
			defaults: { waitForFinalization: false },
			allowed: ['releaseNotes', 'signal'],
		});
		const properties = await makeRequest({
			method: 'POST',
			path: `${this.uri}/versions/next/release`,
			payload: { releaseNotes },
		});
		if (waitForFinalization) {
			await waitForVersionFinalization(new Version(properties.tag, { dataset: this, properties }), { signal });
		}
		this.uri = properties.datasetUri;
		return this.get();
	}

	/**
	 * Unreleases the current version of the dataset, making it the next version again.
	 *
	 * @param {[options?: {waitForFinalization?: boolean, signal?: AbortSignal}]} args With `waitForFinalization`, wait
	 *   until the unrelease has been finalized, after which the dataset can be released, unreleased, or deleted again.
	 *   The signal stops waiting, but doesn't cancel the unrelease.
	 * @returns {Promise<this>} This dataset, at its (now unreleased) next version
	 */
	async unrelease(...args) {
		const { waitForFinalization, signal } = parseArgs(args, [], {
			defaults: { waitForFinalization: false },
			allowed: ['signal'],
		});
		const properties = await makeRequest({ method: 'POST', path: `${this.uri}/versions/current/unrelease` });
		if (waitForFinalization) {
			await waitForVersionFinalization(new Version(properties.tag, { dataset: this, properties }), { signal });
		}
		this.uri = properties.datasetUri;
		return this.get();
	}

	/**
	 * Returns a version of the dataset: the given tag, or else the version this dataset refers to.
	 *
	 * @param {[tag?: string] | [options?: {tag?: string}]} args
	 * @returns {Promise<Version>}
	 */
	async version(...args) {
		const { tag } = parseArgs(args, ['tag']);
		if (!tag && !this.versionTag) {
			await this.get();
		}
		return new Version(tag || this.versionTag, { dataset: this });
	}

	/**
	 * Returns the dataset at the version before this one, or null if this is the first version.
	 * @returns {Promise<Dataset|null>}
	 */
	async previousVersion() {
		const version = await (await this.version()).previousVersion();
		return version && version.dataset();
	}

	/**
	 * Returns the dataset at the version after this one, or null if this is the latest version.
	 * @returns {Promise<Dataset|null>}
	 */
	async nextVersion() {
		const version = await (await this.version()).nextVersion();
		return version && version.dataset();
	}

	/**
	 * @param {ListArgs} args
	 * @returns {Promise<Version[]>}
	 */
	async listVersions(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		const versions = await makePaginatedRequest({ path: `${this.uri}/versions`, pageSize: 100, maxResults });
		return versions.map((version) => new Version(version.tag, { dataset: this, properties: version }));
	}

	/**
	 * @param {ListArgs} args
	 * @returns {Promise<Table[]>}
	 */
	async listTables(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		const tables = await makePaginatedRequest({ path: `${this.uri}/tables`, pageSize: 100, maxResults });
		return tables.map((table) => new Table(table.name, { dataset: this, properties: table }));
	}

	/** @protected */
	_updateProperties(properties) {
		super._updateProperties(properties);
		this.name = properties.name;
		if (properties.version?.tag) {
			this.versionTag = normalizeVersionTag(properties.version.tag);
		}
		if (this.user && this.organization && properties.owner?.kind) {
			if (properties.owner.kind === 'user') {
				this.organization = undefined;
			} else {
				this.user = undefined;
			}
		}
	}

	// When the owner came from a qualified reference, we don't know whether it's a user or an organization until the
	//   API tells us (or we ask)
	/** @protected */
	async _rectifyAmbiguousOwner() {
		if (this.user && this.organization) {
			if (await this.organization.exists()) {
				this.user = undefined;
			} else {
				this.organization = undefined;
			}
		}
	}
}

// The tags `v1.0` and `v1_0` are equivalent, but only the latter can be used in a reference
export function normalizeVersionTag(tag) {
	if (!tag) {
		return undefined;
	}
	tag = String(tag).replace(/^(v?\d+)\.(\d+)$/i, '$1_$2');
	if (tag !== 'current' && tag !== 'next' && !tag.toLowerCase().startsWith('v')) {
		return `v${tag}`;
	}
	return tag;
}
