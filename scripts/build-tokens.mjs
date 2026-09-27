#!/usr/bin/env node
/**
 * build-tokens.mjs
 * ---------------------------------------------------------------------------
 * Entry point. Reads a Figma/W3C design token export and writes:
 *
 *   dist/tokens.css            the custom properties, the thing apps import
 *   dist/tokens.report.json    machine readable description of every variable
 *   dist/TOKENS.md             the reference developers read
 *   dist/tokens.preview.html   a self-contained visual style guide
 *
 * The design system this file serves has a two tier colour model, and the
 * whole pipeline is built around keeping that boundary intact:
 *
 *   `colour roles`      --ds-color-*             apply these in the UI
 *          |  aliased to
 *          v
 *   `primitive colours` --ds-color-primitive-*   foundations, never in the UI
 *
 * Roles are emitted as `var()` references to primitives by default, so the
 * alias graph authored in Figma survives into CSS and a theme only has to
 * re-point the role block. See README.md for the full rationale.
 *
 * Usage: node scripts/build-tokens.mjs --help
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { helpText, OPTION_SPEC, parseArgs } from './lib/args.mjs';
import { buildTokens } from './lib/build.mjs';
import { emitCss } from './lib/emit-css.mjs';
import { emitHtml } from './lib/emit-html.mjs';
import { emitMarkdown } from './lib/emit-markdown.mjs';
import { emitReport } from './lib/emit-report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VERSION = readVersion();
const GENERATOR = 'scripts/build-tokens.mjs';

/** Read the version from package.json without a JSON import assertion dance. */
function readVersion() {
  try {
    const raw = readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    return JSON.parse(raw).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main() {
  const { options, errors, seen } = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(`${helpText(VERSION)}\n`);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`error: ${error}\n`);
    process.stderr.write('\nRun with --help for usage.\n');
    return 2;
  }

  const inputPath = path.resolve(process.cwd(), options.input);
  if (!existsSync(inputPath)) {
    process.stderr.write(`error: token file not found: ${options.input}\n`);
    return 2;
  }

  const document = await readJson(inputPath);
  const fileConfig = await readConfig(options.config);
  const build = buildTokens(document, {
    ...fileConfig,
    ...pickCliOverrides(options, seen),
    source: displayPath(inputPath),
  });

  const source = displayPath(inputPath);
  const css = emitCss(build, { source, indent: options.indent });
  const files = [
    { name: 'tokens.css', content: css },
    { name: 'tokens.report.json', content: emitReport(build, { source }) },
    { name: 'TOKENS.md', content: emitMarkdown(build, { source }) },
    { name: 'tokens.preview.html', content: emitHtml(build, { source, css }) },
  ];

  if (options.stdout) {
    process.stdout.write(files[0].content);
    return report(build, files, { ...options, outDir: null, written: false });
  }

  const outDir = path.resolve(process.cwd(), options.out);
  const outcomes = [];

  if (options.check) {
    for (const file of files) {
      const target = path.join(outDir, file.name);
      if (!existsSync(target)) outcomes.push({ name: file.name, state: 'missing' });
      else {
        const current = await readFile(target, 'utf8');
        outcomes.push({
          name: file.name,
          state: current === file.content ? 'current' : 'stale',
          firstDifference: current === file.content ? null : firstDifference(current, file.content),
        });
      }
    }
  } else {
    await mkdir(outDir, { recursive: true });
    for (const file of files) {
      await writeFile(path.join(outDir, file.name), file.content, 'utf8');
      outcomes.push({ name: file.name, state: 'written' });
    }
  }

  return report(build, files, { ...options, outDir, written: !options.check, outcomes });
}

/* ---------------------------------------------------------------- reporting */

/**
 * Print the build summary. This is the part a human actually reads, so it
 * leads with the counts, then the colour model, then findings most severe
 * first, and finishes with what to do next.
 */
function report(build, files, { quiet, verbose, strict, check, outDir, outcomes = [], written }) {
  const { stats, warnings } = build;
  const errors = warnings.filter((w) => w.level === 'error');
  const warns = warnings.filter((w) => w.level === 'warn');
  const infos = warnings.filter((w) => w.level === 'info');
  const out = [];
  const say = (line = '') => out.push(line);

  if (!quiet || errors.length > 0) {
    say();
    say(`  ${GENERATOR}`);
    say(`  ${'-'.repeat(74)}`);
    say(`  source        ${build.source}`);
    say(`  prefix        ${build.config.prefix}      colours ${build.config.colorFormat}      units ${build.config.unit}`);
    say(`  role values   ${build.config.roleValues === 'alias' ? 'var() references to primitives' : 'literal resolved colours'}`);
    say();
    say(`  ${stats.variables} custom properties from ${stats.tokens} tokens`);
    say(`    ${pad(stats.roles, 3)} colour roles          ${pad(stats.primitives, 3)} primitive colours`);
    say(`    ${pad(stats.spacing, 3)} spacing steps        ${pad(stats.typographyStyles, 3)} text styles (${stats.typographyVariables} variables)`);
    say(`    ${pad(stats.shadows, 3)} shadows              ${pad(stats.pairs, 3)} contrast pairs checked`);
    say();

    if (check) {
      const stale = outcomes.filter((o) => o.state !== 'current');
      for (const outcome of outcomes) {
        const icon = outcome.state === 'current' ? 'ok  ' : outcome.state === 'missing' ? 'new ' : 'stale';
        say(`  [${icon}] ${outcome.name}${outcome.firstDifference ? `  first difference at line ${outcome.firstDifference}` : ''}`);
      }
      say();
      if (stale.length > 0) {
        say(`  ${stale.length} generated file${stale.length === 1 ? '' : 's'} out of date. Run: npm run build`);
      } else {
        say('  All generated files are up to date.');
      }
      say();
    } else if (written) {
      for (const outcome of outcomes) say(`  wrote  ${path.join(displayPath(outDir) ?? '', outcome.name)}`);
      say();
      say(`  open  ${displayPath(path.join(outDir, 'tokens.preview.html'))}   visual style guide`);
      say(`  read  ${displayPath(path.join(outDir, 'TOKENS.md'))}         reference`);
    } else {
      for (const file of files) say(`  file  ${file.name}  (${formatBytes(Buffer.byteLength(file.content))})`);
      say();
    }

    if (verbose || errors.length > 0 || warns.length > 0) {
      say(`  findings  ${errors.length} error, ${warns.length} warning, ${infos.length} note`);
      const shown = verbose ? warnings : [...errors, ...warns];
      for (const warning of shown) {
        say(`    ${label(warning.level)} ${warning.code}  ${warning.token}`);
        say(`           ${wrap(warning.message, 66, 11)}`);
      }
      if (!verbose && infos.length > 0) {
        say(`    note   ${infos.length} informational finding(s) hidden; rerun with --verbose`);
      }
      say();
    }
  }

  say(
    `  ${check ? 'checked' : 'built'} ${stats.variables} variables` +
      `  |  ${errors.length} error  ${warns.length} warning  ${infos.length} note`,
  );
  say();

  process.stdout.write(`${out.join('\n')}\n`);

  if (errors.length > 0) return 1;
  if (check && outcomes.some((o) => o.state !== 'current')) return 1;
  if (strict && warns.length > 0) return 1;
  return 0;
}

/* ------------------------------------------------------------------ helpers */

const CLI_KEY_MAP = {
  prefix: 'prefix',
  unit: 'unit',
  'root-size': 'rootSize',
  'color-format': 'colorFormat',
  'role-values': 'roleValues',
  'font-stack': 'fontStack',
  channels: 'channels',
  'alpha-vars': 'alphaVars',
  'font-shorthand': 'fontShorthand',
  sort: 'sort',
};

/**
 * Only forward options the user actually typed, so values in the config file
 * are not silently overwritten by the parser defaults.
 */
function pickCliOverrides(options, seen = new Set()) {
  const overrides = {};
  for (const [cliKey, buildKey] of Object.entries(CLI_KEY_MAP)) {
    if (!seen.has(cliKey)) continue;
    overrides[buildKey] = options[cliKey];
  }
  return overrides;
}

async function readJson(file) {
  const raw = await readFile(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
}

async function readConfig(file) {
  if (!file) return {};
  const target = path.resolve(process.cwd(), file);
  if (!existsSync(target)) return {};
  const config = await readJson(target);
  const { $comment, ...rest } = config;
  return rest;
}

function displayPath(absolute) {
  if (!absolute) return null;
  const relative = path.relative(process.cwd(), absolute);
  return relative && !relative.startsWith('..') ? relative : absolute;
}

function pad(value, width) {
  return String(value).padStart(width, ' ');
}

function label(level) {
  return level === 'error' ? '[error]' : level === 'warn' ? '[warn] ' : '[note] ';
}

function wrap(text, width, indent) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current && current.length + word.length + 1 > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.join(`\n${' '.repeat(indent)}`);
}

function firstDifference(current, next) {
  const a = current.split('\n');
  const b = next.split('\n');
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return index + 1;
  }
  return 1;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} kB`;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`\nerror: ${error.message}\n\n`);
    process.exitCode = 1;
  });
