#!/usr/bin/env bun
// Regenerates the README quality-control section from docs/quality-controls.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface QualityControl {
  control: string;
  automation: string;
  enforcement: string;
  purpose: string;
}

const ROOT = process.cwd();
const README = resolve(ROOT, 'README.md');
const CONTROLS = resolve(ROOT, 'docs/quality-controls.json');
const START = '<!-- AI_QUALITY_CONTROLS_START -->';
const END = '<!-- AI_QUALITY_CONTROLS_END -->';

const controls = JSON.parse(readFileSync(CONTROLS, 'utf8')) as QualityControl[];
const section = renderSection(controls);
const readme = readFileSync(README, 'utf8');

const nextReadme = replaceOrInsert(readme, section);
if (nextReadme !== readme) {
  writeFileSync(README, nextReadme);
  console.log('README.md quality-control section updated.');
} else {
  console.log('README.md quality-control section already up to date.');
}

function renderSection(items: QualityControl[]): string {
  const rows = items
    .map((item) => `| ${esc(item.control)} | ${esc(item.automation)} | ${esc(item.enforcement)} | ${esc(item.purpose)} |`)
    .join('\n');

  return `${START}
## Automated AI Quality Controls

This section is generated from \`docs/quality-controls.json\`. Run \`bun run quality:readme\` after changing the quality gate manifest.

| Control | Automation | Enforcement | Purpose |
|---------|------------|-------------|---------|
${rows}

### Local Quality Commands

\`\`\`bash
bun run quality:ai              # typecheck + lint + build + fitness + supply-chain + architecture
bun run quality:ai:test         # quality:ai plus the unit suite
bun run quality:ai:deep         # quality:ai:test plus mutation testing
bun run quality:fitness:debt    # inspect current complexity/module-size structural debt
bun run quality:fitness:strict  # fail on current complexity/module-size ratchet warnings
bun run quality:supply-chain    # audit CI/Docker supply-chain hardening
bun run quality:architecture:strict # include circular dependency warnings
bun run quality:deadcode        # Knip dead-code/dependency audit without failing on existing debt
bun run quality:deadcode:strict # fail on Knip issues after the debt is triaged
bun run test:properties         # property-based invariant tests
\`\`\`
${END}`;
}

function replaceOrInsert(source: string, section: string): string {
  const startIndex = source.indexOf(START);
  const endIndex = source.indexOf(END);
  if (startIndex >= 0 && endIndex > startIndex) {
    return `${source.slice(0, startIndex)}${section}${source.slice(endIndex + END.length)}`;
  }

  const buildIndex = source.indexOf('\n## Build\n');
  if (buildIndex >= 0) {
    return `${source.slice(0, buildIndex)}\n\n${section}\n${source.slice(buildIndex)}`;
  }

  return `${source.trimEnd()}\n\n${section}\n`;
}

function esc(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
