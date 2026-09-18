// Usage: npm run release -- patch|minor|major
// Bumps the version, tags v<version>, and pushes branch + tag.
// Pushing the tag triggers .github/workflows/release.yml.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const index = { major: 0, minor: 1, patch: 2 }[process.argv[2] ?? ''];
if (index === undefined) {
  console.error('Usage: npm run release -- <patch|minor|major>');
  process.exit(1);
}
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const out = (cmd) => execSync(cmd).toString().trim();
const cleanTree = () => out('git status --porcelain --untracked-files=no') === '';

const parts = JSON.parse(readFileSync('package.json', 'utf8')).version.split('.').map(Number);
parts[index]++;
for (let i = index + 1; i < 3; i++) parts[i] = 0;
const version = parts.join('.');
const tag = `v${version}`;

if (out('git branch --show-current') !== 'main') {
  console.error('Release from main only.');
  process.exit(1);
}
if (!cleanTree()) {
  console.error('Working tree not clean. Commit first.');
  process.exit(1);
}

run('npm run typecheck');
run('npm run package');

for (const file of ['package.json', 'public/manifest.json']) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  if (json.version !== version) {
    json.version = version;
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  }
}
if (!cleanTree()) run(`git commit -am "Release ${tag}"`);
run(`git tag -a ${tag} -m ${tag}`);
run(`git push origin HEAD ${tag}`);
