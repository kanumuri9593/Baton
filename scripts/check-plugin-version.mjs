// Fails when the Claude Code plugin's pinned Baton version drifts from package.json.
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const version = JSON.parse(read('package.json')).version;
const plugin = JSON.parse(read('plugins/baton/.claude-plugin/plugin.json')).version;
const pinned = [
  'plugins/baton/.mcp.json',
  'plugins/baton/README.md',
  'plugins/baton/skills/using-baton/SKILL.md',
  'plugins/baton/skills/doctor/SKILL.md',
];

const problems = [];
if (plugin !== version) problems.push(`plugin.json version ${plugin} != package.json ${version}`);
for (const path of pinned) {
  for (const [, pin] of read(path).matchAll(/baton-run@([\d.]+)/g)) {
    if (pin !== version) problems.push(`${path} pins baton-run@${pin}, expected ${version}`);
  }
}
if (!read('plugins/baton/.mcp.json').includes(`baton-run@${version}`)) {
  problems.push(`plugins/baton/.mcp.json does not pin baton-run@${version}`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`Claude Code plugin pinned to baton-run@${version}`);
