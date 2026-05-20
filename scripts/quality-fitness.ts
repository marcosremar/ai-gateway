#!/usr/bin/env bun
// AI Gateway - AI Quality Fitness Gate
// Verifies codebase boundaries and AI-era quality guardrails without adding
// another framework dependency to the repository.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import * as ts from 'typescript';

type Area = 'src' | 'server' | 'sdk' | 'web' | 'other';
type Severity = 'error' | 'warn';

interface Finding {
  severity: Severity;
  rule: string;
  file: string;
  line?: number;
  message: string;
  baselineReason?: string;
}

interface ImportRef {
  specifier: string;
  line: number;
}

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface BaselineEntry {
  rule: string;
  file: string;
  reason: string;
}

interface QualityBaseline {
  knownErrors?: BaselineEntry[];
}

const ROOT = process.cwd();
const args = new Set(process.argv.slice(2));
const strict = args.has('--strict');
const json = args.has('--json');
const showWarnings = strict || args.has('--warnings');

const SOURCE_ROOTS = ['src', 'server', 'sdk', 'web/src'];
const TEXT_SCAN_ROOTS = [
  'Dockerfile',
  'Dockerfile.production',
  'Dockerfile.worker',
  'dockers',
  'scripts',
  '.github',
];

const IGNORED_DIRS = new Set([
  '.git',
  '.next',
  '.stryker-tmp',
  'coverage',
  'dist',
  'node_modules',
  'reports',
]);

const MAX_FUNCTION_COMPLEXITY = 30;
const MAX_FILE_LINES = 900;
const MAX_IMPORTS_PER_MODULE = 50;
const MAX_PRINTED_FINDINGS = 30;
const DEPRECATED_HF_TRANSFER_ENV = ['HF', 'HUB', 'ENABLE', 'HF', 'TRANSFER'].join('_');

const BUILTINS = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  'bun',
  'bun:test',
]);

const FORBIDDEN_SRC_PACKAGES = new Map<string, string>([
  ['@prisma/client', 'src/ is publishable and must use DI instead of Prisma directly.'],
  ['prisma', 'src/ is publishable and must use DI instead of Prisma directly.'],
  ['redis', 'src/ must use StateStore instead of Redis directly.'],
  ['ioredis', 'src/ must use StateStore instead of Redis directly.'],
  ['next', 'src/ must not depend on Next.js. Keep Next.js in web/.'],
]);

const SHARED_UI_COMPONENTS = new Set([
  'AlertBanner',
  'Button',
  'Card',
  'ConfirmModal',
  'CopyButton',
  'DropdownList',
  'FormInput',
  'FormSelect',
  'IconBox',
  'KV',
  'SaveBar',
  'SectionHeader',
  'Sidebar',
  'Skeleton',
  'Spinner',
  'StatusBadge',
  'StatusDot',
  'TabNav',
  'Toast',
  'Toggle',
]);

const findings: Finding[] = [];

function main(): void {
  const rootPackage = readPackageJson('package.json');
  const webPackage = readPackageJson('web/package.json');
  const baseline = readQualityBaseline();
  const rootDeclared = declaredPackages(rootPackage);
  const webDeclared = new Set([...rootDeclared, ...declaredPackages(webPackage)]);

  if (rootPackage.name) rootDeclared.add(rootPackage.name);
  if (webPackage.name) webDeclared.add(webPackage.name);

  const sourceFiles = SOURCE_ROOTS.flatMap((root) => collectFiles(root, ['.ts', '.tsx']));
  const textFiles = TEXT_SCAN_ROOTS.flatMap((root) => collectTextFiles(root));

  for (const file of sourceFiles) {
    inspectSourceFile(file, rootPackage, rootDeclared, webDeclared);
  }

  for (const file of textFiles) {
    inspectTextFile(file);
  }

  applyBaseline(baseline);

  const errors = findings.filter((finding) => finding.severity === 'error');
  const warnings = findings.filter((finding) => finding.severity === 'warn');

  if (json) {
    console.log(JSON.stringify({ errors, warnings }, null, 2));
  } else {
    printReport(sourceFiles.length, textFiles.length, errors, showWarnings ? warnings : []);
  }

  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

function readPackageJson(path: string): PackageJson {
  const absPath = resolve(ROOT, path);
  if (!existsSync(absPath)) return {};
  return JSON.parse(readFileSync(absPath, 'utf8')) as PackageJson;
}

function readQualityBaseline(): QualityBaseline {
  const absPath = resolve(ROOT, 'quality-fitness-baseline.json');
  if (!existsSync(absPath)) return {};
  return JSON.parse(readFileSync(absPath, 'utf8')) as QualityBaseline;
}

function applyBaseline(baseline: QualityBaseline): void {
  const knownErrors = baseline.knownErrors ?? [];
  for (const finding of findings) {
    if (finding.severity !== 'error') continue;
    const known = knownErrors.find((entry) => entry.rule === finding.rule && entry.file === finding.file);
    if (!known) continue;

    finding.severity = 'warn';
    finding.baselineReason = known.reason;
    finding.message = `${finding.message} Known baseline violation: ${known.reason}`;
  }
}

function declaredPackages(pkg: PackageJson): Set<string> {
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
}

function collectFiles(root: string, extensions: string[]): string[] {
  const absRoot = resolve(ROOT, root);
  if (!existsSync(absRoot)) return [];

  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (IGNORED_DIRS.has(entry)) continue;
      const absEntry = resolve(dir, entry);
      const stat = statSync(absEntry);

      if (stat.isDirectory()) {
        visit(absEntry);
        continue;
      }

      if (stat.isFile() && extensions.includes(extname(entry))) {
        out.push(absEntry);
      }
    }
  };

  visit(absRoot);
  return out;
}

function collectTextFiles(root: string): string[] {
  const absRoot = resolve(ROOT, root);
  if (!existsSync(absRoot)) return [];
  const stat = statSync(absRoot);

  if (stat.isFile()) return [absRoot];

  const extensions = ['.Dockerfile', '.cjs', '.js', '.mjs', '.py', '.sh', '.ts', '.tsx', '.yml', '.yaml'];
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (IGNORED_DIRS.has(entry)) continue;
      const absEntry = resolve(dir, entry);
      const entryStat = statSync(absEntry);

      if (entryStat.isDirectory()) {
        visit(absEntry);
        continue;
      }

      if (!entryStat.isFile()) continue;
      const ext = extname(entry);
      if (extensions.includes(ext) || entry.startsWith('Dockerfile')) {
        out.push(absEntry);
      }
    }
  };

  visit(absRoot);
  return out;
}

function inspectSourceFile(
  absFile: string,
  rootPackage: PackageJson,
  rootDeclared: Set<string>,
  webDeclared: Set<string>,
): void {
  const relFile = toRel(absFile);
  const source = readFileSync(absFile, 'utf8');
  const sourceFile = ts.createSourceFile(
    relFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    relFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const area = areaOf(absFile);
  const imports = collectImports(sourceFile);
  const declared = area === 'web' ? webDeclared : rootDeclared;

  inspectModuleSize(absFile, source, imports.length);
  inspectImports(absFile, area, imports, declared, rootPackage.name);
  inspectComplexity(absFile, sourceFile);
  inspectSharedUiReimplementation(absFile, sourceFile);
}

function collectImports(sourceFile: ts.SourceFile): ImportRef[] {
  const imports: ImportRef[] = [];

  const add = (node: ts.Node, specifier: string): void => {
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    imports.push({ specifier, line: pos.line + 1 });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier, node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier, node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node)
      && node.arguments.length > 0
      && ts.isStringLiteral(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || isIdentifier(node.expression, 'require'))
    ) {
      add(node.arguments[0], node.arguments[0].text);
    } else if (
      ts.isImportTypeNode(node)
      && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)
    ) {
      add(node.argument.literal, node.argument.literal.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return imports;
}

function inspectImports(
  absFile: string,
  area: Area,
  imports: ImportRef[],
  declared: Set<string>,
  rootPackageName?: string,
): void {
  for (const importRef of imports) {
    const specifier = importRef.specifier;
    const resolved = resolveInternal(absFile, specifier, rootPackageName);
    const pkg = packageName(specifier, rootPackageName);

    if (resolved) {
      inspectBoundary(absFile, area, importRef, resolved);
    }

    if (area === 'src' || area === 'sdk') {
      inspectForbiddenPublishablePackage(absFile, importRef, specifier);
    }

    if (pkg && !declared.has(pkg)) {
      addFinding('error', 'declared-dependencies', absFile, importRef.line, `External package "${pkg}" is imported but not declared in package.json. This catches hallucinated dependencies before install/runtime.`);
    }
  }
}

function inspectBoundary(absFile: string, area: Area, importRef: ImportRef, resolved: string): void {
  if ((area === 'src' || area === 'sdk') && isInside(resolved, 'server')) {
    addFinding('error', 'src-server-boundary', absFile, importRef.line, 'Publishable code must not import server/. Move shared logic into src/ and inject delivery concerns.');
  }

  if ((area === 'src' || area === 'sdk') && isInside(resolved, 'web')) {
    addFinding('error', 'publishable-web-boundary', absFile, importRef.line, 'Publishable code must not import web/. Keep Next.js/UI delivery concerns isolated.');
  }

  if (area === 'web' && isInside(resolved, 'server')) {
    addFinding('error', 'web-server-boundary', absFile, importRef.line, 'web/src must talk to the Gateway API, not import server/ directly.');
  }

  if (area === 'web' && isInside(resolved, 'src') && !isInside(resolved, 'src/browser')) {
    addFinding('error', 'web-src-boundary', absFile, importRef.line, 'web/src may import the browser SDK only; use HTTP/WebSocket clients for Gateway interactions.');
  }

  if (area === 'server' && isInside(resolved, 'web')) {
    addFinding('error', 'server-web-boundary', absFile, importRef.line, 'server/ must not import web/. Keep delivery layers independent.');
  }
}

function inspectForbiddenPublishablePackage(absFile: string, importRef: ImportRef, specifier: string): void {
  for (const [pkg, message] of FORBIDDEN_SRC_PACKAGES) {
    if (specifier === pkg || specifier.startsWith(`${pkg}/`)) {
      addFinding('error', 'publishable-direct-infra', absFile, importRef.line, message);
    }
  }
}

function inspectModuleSize(absFile: string, source: string, importCount: number): void {
  const lines = source.split('\n').length;
  if (lines > MAX_FILE_LINES) {
    addFinding(strict ? 'error' : 'warn', 'module-size', absFile, 1, `Module has ${lines} lines; target <= ${MAX_FILE_LINES}. AI changes should split large modules before adding more behavior.`);
  }

  if (importCount > MAX_IMPORTS_PER_MODULE) {
    addFinding(strict ? 'error' : 'warn', 'module-coupling', absFile, 1, `Module has ${importCount} imports; target <= ${MAX_IMPORTS_PER_MODULE}. Check whether a bounded context boundary is being blurred.`);
  }
}

function inspectComplexity(absFile: string, sourceFile: ts.SourceFile): void {
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      const complexity = cyclomaticComplexity(node);
      if (complexity > MAX_FUNCTION_COMPLEXITY) {
        const name = functionName(node);
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        addFinding(strict ? 'error' : 'warn', 'cyclomatic-complexity', absFile, pos.line + 1, `${name} has cyclomatic complexity ${complexity}; target <= ${MAX_FUNCTION_COMPLEXITY}. Ask the agent to extract decision points behind named functions.`);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

function inspectSharedUiReimplementation(absFile: string, sourceFile: ts.SourceFile): void {
  if (!isInside(absFile, 'web/src') || isInside(absFile, 'web/src/components/ui')) return;

  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      if (SHARED_UI_COMPONENTS.has(node.name.text)) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile));
        addFinding('error', 'shared-ui-boundary', absFile, pos.line + 1, `Do not re-implement ${node.name.text}; import it from web/src/components/ui.`);
      }
    }

    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && SHARED_UI_COMPONENTS.has(declaration.name.text)) {
          const pos = sourceFile.getLineAndCharacterOfPosition(declaration.name.getStart(sourceFile));
          addFinding('error', 'shared-ui-boundary', absFile, pos.line + 1, `Do not re-implement ${declaration.name.text}; import it from web/src/components/ui.`);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

function inspectTextFile(absFile: string): void {
  const source = readFileSync(absFile, 'utf8');
  if (source.includes(DEPRECATED_HF_TRANSFER_ENV)) {
    addFinding(strict ? 'error' : 'warn', 'hf-xet-policy', absFile, lineOf(source, DEPRECATED_HF_TRANSFER_ENV), 'Deprecated Hugging Face transfer env var found. Use HF_XET_HIGH_PERFORMANCE and hf_xet instead.');
  }
}

function resolveInternal(absFile: string, specifier: string, rootPackageName?: string): string | null {
  if (specifier.startsWith('.')) {
    return resolve(dirname(absFile), specifier);
  }

  if (specifier === '@ai-gateway') {
    return resolve(ROOT, 'src/index.ts');
  }

  if (specifier.startsWith('@ai-gateway/')) {
    return resolve(ROOT, 'src', specifier.slice('@ai-gateway/'.length));
  }

  if (rootPackageName && specifier === rootPackageName) {
    return resolve(ROOT, 'src/index.ts');
  }

  if (rootPackageName && specifier.startsWith(`${rootPackageName}/`)) {
    return resolve(ROOT, specifier.slice(rootPackageName.length + 1));
  }

  if (specifier.startsWith('@/')) {
    return resolve(ROOT, 'web/src', specifier.slice(2));
  }

  if (specifier.startsWith('src/') || specifier.startsWith('server/') || specifier.startsWith('sdk/')) {
    return resolve(ROOT, specifier);
  }

  return null;
}

function packageName(specifier: string, rootPackageName?: string): string | null {
  if (
    specifier.startsWith('.')
    || specifier.startsWith('@/') 
    || specifier.startsWith('#')
    || specifier.startsWith('src/')
    || specifier.startsWith('server/')
    || specifier.startsWith('sdk/')
    || specifier === '@ai-gateway'
    || specifier.startsWith('@ai-gateway/')
    || specifier === rootPackageName
    || (rootPackageName && specifier.startsWith(`${rootPackageName}/`))
  ) {
    return null;
  }

  if (BUILTINS.has(specifier)) return null;

  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return name ? `${scope}/${name}` : specifier;
  }

  return specifier.split('/')[0] ?? specifier;
}

function areaOf(absFile: string): Area {
  if (isInside(absFile, 'web/src')) return 'web';
  if (isInside(absFile, 'server')) return 'server';
  if (isInside(absFile, 'sdk')) return 'sdk';
  if (isInside(absFile, 'src')) return 'src';
  return 'other';
}

function isInside(absPath: string, relRoot: string): boolean {
  const rel = relative(resolve(ROOT, relRoot), absPath);
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.startsWith(sep));
}

function isIdentifier(node: ts.Node, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node);
}

function cyclomaticComplexity(node: ts.Node): number {
  let complexity = 1;

  const visit = (child: ts.Node): void => {
    if (child !== node && isFunctionLike(child)) return;

    switch (child.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.CaseClause:
        complexity += 1;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const expression = child as ts.BinaryExpression;
        if (
          expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
          || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
          || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ) {
          complexity += 1;
        }
        break;
      }
      default:
        break;
    }

    ts.forEachChild(child, visit);
  };

  visit(node);
  return complexity;
}

function functionName(node: ts.FunctionLikeDeclaration): string {
  if ('name' in node && node.name) return node.name.getText();
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent)) return parent.name.getText();
  }
  return '<anonymous>';
}

function lineOf(source: string, needle: string): number {
  const index = source.indexOf(needle);
  if (index < 0) return 1;
  return source.slice(0, index).split('\n').length;
}

function addFinding(severity: Severity, rule: string, absFile: string, line: number | undefined, message: string): void {
  findings.push({ severity, rule, file: toRel(absFile), line, message });
}

function toRel(absFile: string): string {
  return relative(ROOT, absFile);
}

function printReport(scannedSourceFiles: number, scannedTextFiles: number, errors: Finding[], warnings: Finding[]): void {
  console.log('AI Quality Fitness Gate');
  console.log('=======================');
  console.log(`Source files scanned: ${scannedSourceFiles}`);
  console.log(`Policy files scanned: ${scannedTextFiles}`);
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
    console.log(strict ? 'Strict gate passed.' : 'Gate passed. Existing structural debt is hidden by default; use --warnings to inspect it or --strict to fail on it.');
  }
}

main();
