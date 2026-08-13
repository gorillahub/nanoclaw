import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function log(msg) { process.stdout.write(msg + '\n'); }
function fail(msg) { process.stderr.write(`state-check: ${msg}\n`); process.exit(1); }

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
  if (!md.startsWith('---\n')) return false;
  const end = md.indexOf('\n---', 4);
  return end !== -1;
}

function looksLikeGsdKv(md) {
  return /\*\*Status:\*\*/i.test(md) || /\*\*Active Milestone:\*\*/i.test(md);
}

// --- milestone-identity guard -------------------------------------------------
// A regenerator (agent or tool) that rewrites STATE.md without the real
// milestone context defaults the identity to the generic placeholder
// (`milestone: v1.0 / milestone_name: milestone / status: Awaiting next
// milestone`) and counts ALL phase dirs instead of the current milestone's.
// That is valid YAML, so the parseability check above passes it, and it has
// reached origin and needed hand-repair more than once (see .planning/STATE.md
// history: "corrupted milestone identity again"). This guard rejects that
// regression so it can never be committed. It only fires on unambiguous
// corruption (the generic placeholder, or a milestone version BELOW the latest
// shipped one in MILESTONES.md); a legitimate new milestone with a real name
// and an equal-or-higher version passes cleanly.
function frontmatterBlock(md) {
  if (!md.startsWith('---\n')) return null;
  const end = md.indexOf('\n---', 4);
  return end === -1 ? null : md.slice(4, end);
}
function fmField(fm, key) {
  const m = fm.match(new RegExp('^' + key + ':\\s*"?([^"\\n]+?)"?\\s*$', 'm'));
  return m ? m[1].trim() : null;
}
function milestoneVersion(v) {
  const m = v && String(v).match(/v?(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
function cmpVer(a, b) { return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]; }
function latestShippedMilestone(repoRoot) {
  const p = join(repoRoot, '.planning', 'MILESTONES.md');
  if (!existsSync(p)) return null;
  const vers = [...readFileSync(p, 'utf8').matchAll(/^##\s+v(\d+)\.(\d+)\b/gm)]
    .map((m) => [Number(m[1]), Number(m[2])]);
  return vers.length ? vers.reduce((mx, v) => (cmpVer(v, mx) > 0 ? v : mx)) : null;
}
function checkMilestoneIdentity(repoRoot, md) {
  const fm = frontmatterBlock(md);
  if (!fm) return; // KV-style / no frontmatter: identity guard does not apply
  const name = fmField(fm, 'milestone_name');
  if (name !== null && name.toLowerCase() === 'milestone') {
    fail(`STATE.md milestone identity is the generic placeholder (milestone_name: "milestone"). `
      + `A tool or agent regenerated STATE.md without the real milestone context. `
      + `Restore the identity from .planning/MILESTONES.md — do not commit the generic default.`);
  }
  const cur = milestoneVersion(fmField(fm, 'milestone'));
  const latest = latestShippedMilestone(repoRoot);
  if (cur && latest && cmpVer(cur, latest) < 0) {
    fail(`STATE.md milestone regressed to v${cur[0]}.${cur[1]}, below the latest shipped `
      + `milestone v${latest[0]}.${latest[1]} in MILESTONES.md — a scope-blind regeneration. `
      + `Restore the real milestone identity.`);
  }
}

function checkCentral(repoRoot) {
  const p = join(repoRoot, '.planning', 'STATE.md');
  if (!existsSync(p)) fail(`missing ${p}`);
  const md = readFileSync(p, 'utf8');
  if (!looksLikeYamlFrontmatter(md) && !looksLikeGsdKv(md)) {
    fail(`STATE.md not parseable (expected YAML frontmatter or **Key:** Value style)`);
  }
  checkMilestoneIdentity(repoRoot, md);
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
