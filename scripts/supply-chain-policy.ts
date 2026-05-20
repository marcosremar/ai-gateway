#!/usr/bin/env bun
// Supply-chain policy ratchet for AI-generated changes.
// Keeps CI/workflow/Docker drift visible without requiring external scanners.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';

type Severity = 'error' | 'warn';

interface Finding {
  severity: Severity;
  rule: string;
  file: string;
  line?: number;
  message: string;
}

const ROOT = process.cwd();
const args = new Set(process.argv.slice(2));
const strict = args.has('--strict');
const json = args.has('--json');
const findings: Finding[] = [];
const MAX_PRINTED_FINDINGS = 40;
const FULL_SHA = /^[a-f0-9]{40}$/i;
const DEPRECATED_HF_TRANSFER_ENV = ['HF', 'HUB', 'ENABLE', 'HF', 'TRANSFER'].join('_');

function main(): void {
  for (const workflow of collectFiles('.github/workflows', ['.yml', '.yaml'])) {
    inspectWorkflow(workflow);
  }

  for (const dockerfile of collectDockerfiles()) {
    inspectDockerfile(dockerfile);
  }

  const errors = findings.filter((finding) => finding.severity === 'error');
  const warnings = findings.filter((finding) => finding.severity === 'warn');

  if (json) {
    console.log(JSON.stringify({ errors, warnings }, null, 2));
  } else {
    printReport(errors, warnings);
  }

  if (errors.length > 0) process.exitCode = 1;
}

function collectFiles(root: string, extensions: string[]): string[] {
  const absRoot = resolve(ROOT, root);
  if (!existsSync(absRoot)) return [];

  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const absEntry = resolve(dir, entry);
      const stat = statSync(absEntry);
      if (stat.isDirectory()) {
        visit(absEntry);
      } else if (stat.isFile() && extensions.includes(extname(entry))) {
        out.push(absEntry);
      }
    }
  };

  visit(absRoot);
  return out;
}

function collectDockerfiles(): string[] {
  const candidates = ['Dockerfile', 'Dockerfile.production', 'Dockerfile.worker'];
  return [
    ...candidates.map((file) => resolve(ROOT, file)).filter((file) => existsSync(file)),
    ...collectFiles('dockers', ['']).filter((file) => file.split('/').pop()?.startsWith('Dockerfile')),
  ];
}

function inspectWorkflow(absFile: string): void {
  const source = readFileSync(absFile, 'utf8');
  const lines = source.split('\n');

  if (!/^permissions:/m.test(source)) {
    addFinding(strict ? 'error' : 'warn', 'github-actions-permissions', absFile, 1, 'Workflow has no top-level permissions block. Default GITHUB_TOKEN permissions should be reduced explicitly.');
  }

  lines.forEach((line, index) => {
    const uses = line.match(/^\s*(?:-\s*)?uses:\s*['"]?([^'"\s#]+)['"]?/);
    if (uses) inspectActionRef(absFile, index + 1, uses[1]);

    if (line.includes('${{ github.event') && /^\s*(run:|\w+:)/.test(line)) {
      addFinding(strict ? 'error' : 'warn', 'github-actions-event-interpolation', absFile, index + 1, 'Avoid interpolating github.event data directly into shell or env contexts; pass through env and quote defensively.');
    }
  });
}

function inspectActionRef(absFile: string, line: number, ref: string): void {
  if (ref.startsWith('./') || ref.startsWith('docker://')) {
    if (ref.includes(':latest')) {
      addFinding(strict ? 'error' : 'warn', 'github-actions-floating-docker-ref', absFile, line, `Docker action "${ref}" uses a floating latest tag. Pin to a digest.`);
    }
    return;
  }

  const atIndex = ref.lastIndexOf('@');
  if (atIndex < 0) {
    addFinding(strict ? 'error' : 'warn', 'github-actions-unpinned', absFile, line, `Action "${ref}" has no ref. Pin third-party actions to a full commit SHA.`);
    return;
  }

  const version = ref.slice(atIndex + 1);
  if (['main', 'master', 'latest'].includes(version)) {
    addFinding(strict ? 'error' : 'warn', 'github-actions-floating-ref', absFile, line, `Action "${ref}" uses a floating branch/tag. Use a release tag at minimum, preferably a full commit SHA.`);
    return;
  }

  if (!FULL_SHA.test(version)) {
    addFinding(strict ? 'error' : 'warn', 'github-actions-sha-pinning', absFile, line, `Action "${ref}" is not pinned to a full 40-character SHA. This is allowed today but should be ratcheted.`);
  }
}

function inspectDockerfile(absFile: string): void {
  const source = readFileSync(absFile, 'utf8');
  const lines = source.split('\n');

  lines.forEach((line, index) => {
    const from = line.match(/^\s*FROM\s+([^\s]+)/i);
    if (from && from[1].endsWith(':latest')) {
      addFinding(strict ? 'error' : 'warn', 'docker-floating-base-image', absFile, index + 1, `Base image "${from[1]}" uses :latest. Pin an immutable digest or explicit version.`);
    }

    if (/curl\b.*\|\s*(ba)?sh\b/.test(line) || /wget\b.*\|\s*(ba)?sh\b/.test(line)) {
      addFinding(strict ? 'error' : 'warn', 'curl-pipe-shell', absFile, index + 1, 'curl/wget piped to shell should be replaced with checksum-verified downloads or pinned package installs.');
    }

    if (line.includes(DEPRECATED_HF_TRANSFER_ENV)) {
      addFinding(strict ? 'error' : 'warn', 'hf-xet-policy', absFile, index + 1, 'Deprecated Hugging Face transfer env var found. Use HF_XET_HIGH_PERFORMANCE and hf_xet.');
    }
  });
}

function addFinding(severity: Severity, rule: string, absFile: string, line: number | undefined, message: string): void {
  findings.push({ severity, rule, file: relative(ROOT, absFile), line, message });
}

function printReport(errors: Finding[], warnings: Finding[]): void {
  console.log('Supply Chain Policy Gate');
  console.log('========================');
  console.log(`Errors: ${errors.length}`);
  console.log(`Warnings: ${warnings.length}`);

  const printable = [...errors, ...warnings].slice(0, MAX_PRINTED_FINDINGS);
  if (printable.length > 0) {
    console.log('');
    for (const finding of printable) {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      console.log(`${finding.severity.toUpperCase()} ${finding.rule} ${location}`);
      console.log(`  ${finding.message}`);
    }
  }

  if (errors.length + warnings.length > MAX_PRINTED_FINDINGS) {
    console.log('');
    console.log(`Showing first ${MAX_PRINTED_FINDINGS} findings. Re-run with --json for full output.`);
  }

  if (errors.length === 0) {
    console.log('');
    console.log(strict ? 'Strict supply-chain gate passed.' : 'Supply-chain gate passed. Warnings are hardening ratchet targets; use --strict to fail on them.');
  }
}

main();
