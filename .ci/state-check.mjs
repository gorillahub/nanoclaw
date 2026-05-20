import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function log(msg) { process.stdout.write(msg + '
'); }
function fail(msg) { process.stderr.write(`state-check: ${msg}
`); process.exit(1); }

function readClaudeYamlBlock(claudePath) {
  const content = readFileSync(claudePath, 'utf8');
  const m = content.match(/^```yaml\s+([\s\S]*?)^```/m);
  return m ? m[1] : null;
}

function getStateShape(repoRoot) {
  const claudePath = join(repoRoot, 'CLAUDE.md');
  if (!existsSync(claudePath)) return null;
  let yaml;
  try { yaml = readClaudeYamlBlock(claudePath); } catch { return null; }
  if (!yaml) return null;
  const m = yaml.match(/state_shape:\s*"?(\w[\w-]*)"?/);
  if (!m) return null;
  const shape = m[1];
  if (shape === 'pre_gsd') return null;
  if (shape === 'central' || shape === 'distributed' || shape === 'gitignored-local') return shape;
  return null;
}

function looksLikeYamlFrontmatter(md) {
  if (!md.startsWith('---
')) return false;
  const end = md.indexOf('
---', 4);
  return end !== -1;
}

function looksLikeGsdKv(md) {
  return /\*\*Status:\*\*/i.test(md) || /\*\*Active Milestone:\*\*/i.test(md);
}

function checkCentral(repoRoot) {
  const p = join(repoRoot, '.planning', 'STATE.md');
  if (!existsSync(p)) fail(`missing ${p}`);
  const md = readFileSync(p, 'utf8');
  if (looksLikeYamlFrontmatter(md) || looksLikeGsdKv(md)) return;
  fail(`STATE.md not parseable (expected YAML frontmatter or **Key:** Value style)`);
}

function checkGitignoredLocal(repoRoot) {
  const p = join(repoRoot, '.gsd', 'STATE.md');
  if (!existsSync(p)) fail(`missing ${p}`);
  const md = readFileSync(p, 'utf8');
  if (looksLikeYamlFrontmatter(md) || looksLikeGsdKv(md)) return;
  fail(`.gsd/STATE.md not parseable`);
}

function checkDistributed(repoRoot) {
  const dir = join(repoRoot, 'state', 'projects');
  if (!existsSync(dir)) fail(`missing ${dir} (distributed repos must have state/projects/*.md)`);
  const files = readdirSync(dir).filter(f => f.endsWith('.md')).map(f => join(dir, f));
  if (files.length === 0) fail(`no state files found under ${dir}`);
  const ok = files.some(fp => {
    try {
      const md = readFileSync(fp, 'utf8');
      return looksLikeYamlFrontmatter(md) || looksLikeGsdKv(md);
    } catch { return false; }
  });
  if (!ok) fail(`no parseable state files under ${dir}`);
}

function main() {
  const repoRoot = process.cwd();
  const shape = getStateShape(repoRoot);
  if (!shape) {
    log('state-check: skipping (repo not opted into state_contract)');
    process.exit(0);
  }

  if (shape === 'central') return checkCentral(repoRoot);
  if (shape === 'gitignored-local') return checkGitignoredLocal(repoRoot);
  if (shape === 'distributed') return checkDistributed(repoRoot);

  log('state-check: skipping (unknown shape)');
}

main();
