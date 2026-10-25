import Base from './Base.js';
import Organization from './Organization.js';
import Query from './Query.js';
import Table from './Table.js';
import User from './User.js';
import Version from './Version.js';
import { makeRequest, makePaginatedRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { getConfigValue } from '../common/config.js';
import { ValueError } from '../common/errors.js';
import { definedValues, splitReference } from '../common/references.js';

export default class Dataset extends Base {
	/**
	 * @param {string} name The dataset's name, optionally with a reference id and version (`name:abc1:v1_0`). If no
	 *   owner is given, this may be fully qualified (`owner.name`), or else the owner is the configured defaultUser or
	 *   defaultOrganization.
	 * @param {object} [options]
	 * @param {string} [options.version] The version tag, e.g. `v1_0`, `current`, or `next`
	 * @param {User} [options.user]
	 * @param {Organization} [options.organization]
	 * @param {object} [options.properties]
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

		this.name = name.split(':')[0];
		this.user = user;
		this.organization = organization;

		const referenceId = name.replace(/:(v\d+[._]\d+|current|next|sample)/gi, '').split(':')[1];
		if (!version) {
			version = name.match(/:(v\d+[._]\d+|current|next)/i)?.[1];
		}
		this.versionTag = normalizeVersionTag(version);

		this.scopedReference =
			properties?.scopedReference ??
			`${this.name}${referenceId ? `:${referenceId}` : ''}${this.versionTag ? `:${this.versionTag}` : ''}`;
		this.qualifiedReference =
			properties?.qualifiedReference ?? `${(this.organization || this.user).name}.${this.scopedReference}`;
		this.uri = properties?.uri ?? `/datasets/${encodeURIComponent(this.qualifiedReference)}`;
		this.properties = properties;
	}

	table(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Table(name, { dataset: this });
	}

	query(...args) {
		const { query } = parseArgs(args, ['query']);
		return new Query(query, { defaultDataset: this.qualifiedReference });
	}

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
	 * @param {object} options
	 * @param {string} [options.name]
	 * @param {'none'|'overview'|'metadata'|'sample'|'data'} [options.publicAccessLevel]
	 * @param {string} [options.description]
	 * @param {string} [options.methodologyMarkdown]
	 * @param {string} [options.usageMarkdown]
	 * @param {string[]} [options.labels] Replaces the dataset's labels
	 * @param {string[]} [options.labelsToAdd]
	 * @param {string[]} [options.labelsToRemove]
	 * @param {string[]} [options.tags] Replaces the dataset's tags
	 * @param {string[]} [options.tagsToAdd]
	 * @param {string[]} [options.tagsToRemove]
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
	 * @param {object[]} variables
	 * @returns {Promise<void>}
	 */
	async updateVariables(...args) {
		const { variables } = parseArgs(args, ['variables']);
		await makeRequest({ method: 'PATCH', path: `${this.uri}/variables`, payload: { variables } });
	}

	async delete() {
		await makeRequest({ method: 'DELETE', path: this.uri });
	}

	/**
	 * Creates the next (unreleased) version of the dataset, where changes can be made before it's released.
	 *
	 * @param {object} [options]
	 * @param {boolean} [options.ifNotExists=false] Return the existing next version, rather than throwing, if there
	 *   already is one
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
	 * @param {object} [options]
	 * @param {string} [options.releaseNotes]
	 * @returns {Promise<this>} This dataset, at the newly released version
	 */
	async release(...args) {
		const { releaseNotes } = parseArgs(args, [], { allowed: ['releaseNotes'] });
		const { datasetUri } = await makeRequest({
			method: 'POST',
			path: `${this.uri}/versions/next/release`,
			payload: { releaseNotes },
		});
		this.uri = datasetUri;
		return this.get();
	}

	/**
	 * Unreleases the current version of the dataset, making it the next version again.
	 * @returns {Promise<this>} This dataset, at its (now unreleased) next version
	 */
	async unrelease() {
		const { datasetUri } = await makeRequest({ method: 'POST', path: `${this.uri}/versions/current/unrelease` });
		this.uri = datasetUri;
		return this.get();
	}

	/**
	 * Returns a version of the dataset: the given tag, or else the version this dataset refers to.
	 * @param {string} [tag]
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

	async listVersions(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		const versions = await makePaginatedRequest({ path: `${this.uri}/versions`, pageSize: 100, maxResults });
		return versions.map((version) => new Version(version.tag, { dataset: this, properties: version }));
	}

	async listTables(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		const tables = await makePaginatedRequest({ path: `${this.uri}/tables`, pageSize: 100, maxResults });
		return tables.map((table) => new Table(table.name, { dataset: this, properties: table }));
	}

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
