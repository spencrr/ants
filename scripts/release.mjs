#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noConsole: a release script reports what it does.
/**
 * Bumps the version, moves the CHANGELOG's "Unreleased" section under the new version, commits and tags. Pushing the
 * tag starts .github/workflows/release.yml, which tests and builds the tagged commit and then publishes it.
 *
 *   node scripts/release.mjs 0.2.0            # exact version
 *   node scripts/release.mjs patch|minor|major
 *   node scripts/release.mjs 0.2.0 --dry-run  # show the changes, write nothing
 *
 * Patches normally come from main. When main carries unfinished work, branch from the last tag instead
 * (`git switch -c release/0.2 v0.2.0`), cherry-pick the fix with -x, and run this script there.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const spec = args.find(a => !a.startsWith('--'));
if (!spec) {
	console.error('Usage: node scripts/release.mjs <version | patch | minor | major> [--dry-run]');
	process.exit(2);
}

const MANIFEST = 'package.json';
const CHANGELOG = 'CHANGELOG.md';
const REPO_URL = 'https://github.com/spencrr/ants';

const current = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8')).version;
const next = bump(current, spec);
if (!/^\d+\.\d+\.\d+$/.test(next)) {
	console.error(`Not a release version: ${next}`);
	process.exit(2);
}
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
if (git('status', '--porcelain') !== '') {
	console.error('The working tree must be clean.');
	process.exit(1);
}
if (git('tag', '--list', `v${next}`) !== '') {
	console.error(`Tag v${next} already exists.`);
	process.exit(1);
}

console.log(`${current} → ${next}${dryRun ? ' (dry run)' : ''}`);

// A textual replace keeps the manifest's formatting untouched.
const edits = new Map();
const manifest = fs.readFileSync(path.join(root, MANIFEST), 'utf8');
const needle = `"version": "${current}"`;
if (!manifest.includes(needle)) {
	throw new Error(`${MANIFEST} does not carry version ${current}`);
}
edits.set(MANIFEST, manifest.replace(needle, `"version": "${next}"`));

// CHANGELOG: "## Unreleased" becomes "## [<next>] - <date>", with a fresh empty Unreleased section above it.
const changelog = fs.readFileSync(path.join(root, CHANGELOG), 'utf8');
const marker = '## Unreleased';
if (!changelog.includes(marker)) {
	throw new Error(`${CHANGELOG} has no "${marker}" section`);
}
const date = new Date().toISOString().slice(0, 10);
let updatedChangelog = changelog.replace(marker, `${marker}\n\n## [${next}] - ${date}`);
updatedChangelog = updatedChangelog.replace(/\n\[unreleased\]: .*$/im, '');
updatedChangelog = `${updatedChangelog.trimEnd()}\n\n[unreleased]: ${REPO_URL}/compare/v${next}...HEAD\n[${next}]: ${REPO_URL}/compare/v${current}...v${next}\n`;
edits.set(CHANGELOG, updatedChangelog);

for (const [rel, text] of edits) {
	console.log(`  ${rel}`);
	if (!dryRun) {
		fs.writeFileSync(path.join(root, rel), text);
	}
}
if (dryRun) {
	process.exit(0);
}

// The lockfile records the version too. npm is run through this Node binary (no shell, no PATH lookup).
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
execFileSync(
	process.execPath,
	[npmCli, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
	{ cwd: root, stdio: 'inherit' },
);
git('add', '--', ...edits.keys(), 'package-lock.json');
git('commit', '-m', `Release ${next}`);
git('tag', '-a', `v${next}`, '-m', `Ants ${next}`);
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
console.log(
	`\nCommitted and tagged v${next}. Push the branch and the tag:\n` +
		`  git push origin ${branch} v${next}\n` +
		'The release workflow runs the checks on the tagged commit, builds, and then waits for your approval in the\n' +
		'"release" environment on GitHub.',
);

function bump(version, how) {
	const [major, minor, patch] = version.split('.').map(Number);
	switch (how) {
		case 'major':
			return `${major + 1}.0.0`;
		case 'minor':
			return `${major}.${minor + 1}.0`;
		case 'patch':
			return `${major}.${minor}.${patch + 1}`;
		default:
			return how.replace(/^v/, '');
	}
}
