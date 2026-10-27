/**
 * Prints a version's section of CHANGELOG.md, for its GitHub release notes.
 *
 * Usage: node release-notes.js VERSION
 *
 * Exits with an error if there's no section for the version, or it's empty, so that a version is never released
 * without notes.
 */

import { readFileSync } from 'node:fs';

const CHANGELOG = new URL('../../CHANGELOG.md', import.meta.url);

function releaseNotes(version, changelog) {
	// Each section starts with a "## <version>" heading, and runs until the next one. The heading may also bracket the
	// version, prefix it with "v", or follow it with a date
	for (const section of changelog.split(/^## +/m).slice(1)) {
		const [heading, ...notes] = section.split('\n');
		const [word] = heading.trim().split(/\s+/);
		if (word && word.replace(/^\[|\]$/g, '').replace(/^v/, '') === version) {
			return notes.join('\n').trim();
		}
	}
	return null;
}

const version = process.argv[2];
const notes = releaseNotes(version, readFileSync(CHANGELOG, 'utf-8'));
if (!notes) {
	console.error(
		`CHANGELOG.md has no notes for ${version}. Add them under a "## ${version}" heading ` +
			'(e.g., by renaming "## Unreleased")',
	);
	process.exit(1);
}
console.log(notes);
