/**
 * tests/build-tokens.test.mjs
 * ---------------------------------------------------------------------------
 * Run with `npm test` (node:test, no dependencies).
 *
 * The tests are written against the real token file rather than a fixture, so
 * they also act as a regression net for the design system itself: if a
 * designer repoints a role and breaks contrast, these fail.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildTokens } from '../scripts/lib/build.mjs';
import { emitCss } from '../scripts/lib/emit-css.mjs';
import { emitMarkdown } from '../scripts/lib/emit-markdown.mjs';
import { emitReport } from '../scripts/lib/emit-report.mjs';
import { parseColor, contrastRatio, toHex } from '../scripts/lib/color.mjs';
import { kebab, leafName, stepOf, uniqueName } from '../scripts/lib/naming.mjs';
import { flattenTokens, isReference, referenceToPath, resolveTokens } from '../scripts/lib/parse.mjs';
import { parseArgs } from '../scripts/lib/args.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'design-tokens.tokens.json';
const document = JSON.parse(await readFile(path.join(ROOT, SOURCE), 'utf8'));
const build = buildTokens(document, { source: SOURCE });
const css = emitCss(build, { source: SOURCE });

const variable = (name) => build.variables.find((entry) => entry.name === name);

/* ------------------------------------------------------------------ parsing */

test('parses every group in the token file', () => {
  const { tokens, groups } = flattenTokens(document);
  const groupPaths = groups.map((group) => group.join('.'));
  assert.equal(tokens.length, 132);
  assert.ok(groupPaths.includes('primitive colour collection.primary colour palette'));
  assert.ok(groupPaths.includes('colour roles'));
  assert.ok(groupPaths.includes('typography'));
});

test('detects Figma text styles that carry no explicit type', () => {
  const { tokens } = flattenTokens(document);
  const display = tokens.find((token) => token.pathString === 'typography.display large');
  assert.equal(display.kind, 'style-group');
  assert.equal(display.type, 'typography');
  assert.equal(display.value.fontSize.value, 64);
});

test('reads aliases and reference syntax', () => {
  assert.equal(isReference('{primitive colour collection.key colour group.primary key colour}'), true);
  assert.equal(isReference('#2215d6ff'), false);
  assert.deepEqual(referenceToPath('{a.b.c}'), ['a', 'b', 'c']);
});

test('resolves an alias to its primitive value', () => {
  const { tokens } = flattenTokens(document);
  const { resolved } = resolveTokens(tokens);
  const primary = resolved.get('colour roles.primary');
  assert.equal(primary.reference, 'primitive colour collection.key colour group.primary key colour');
  assert.equal(primary.value, '#2215d6ff');
});

test('reports an unresolvable reference instead of throwing', () => {
  const { tokens } = flattenTokens({ broken: { a: { type: 'color', value: '{nowhere.at.all}' } } });
  const { issues, resolved } = resolveTokens(tokens);
  assert.equal(issues[0].code, 'unresolved-reference');
  assert.equal(resolved.get('broken.a').dangling, true);
});

test('detects a circular reference instead of hanging', () => {
  const { tokens } = flattenTokens({
    loop: {
      a: { type: 'color', value: '{loop.b}' },
      b: { type: 'color', value: '{loop.a}' },
    },
  });
  const { issues } = resolveTokens(tokens);
  assert.ok(issues.some((issue) => issue.code === 'reference-cycle'));
});

/* ------------------------------------------------------------------- naming */

test('kebab-cases Figma names', () => {
  assert.equal(kebab('fontSize'), 'font-size');
  assert.equal(kebab('hard shadow'), 'hard-shadow');
  assert.equal(kebab('secondary0'), 'secondary-0');
  assert.equal(kebab('neutral variant 95'), 'neutral-variant-95');
});

test('reads palette steps', () => {
  assert.equal(stepOf('primary-60'), 60);
  assert.equal(stepOf('key-primary'), null);
});

test('removes stutter between a group and its tokens', () => {
  const palette = ['primitive colour collection', 'primary colour palette'];
  assert.equal(leafName({ groupPath: palette, tokenName: 'primary 60' }), '60');
  assert.equal(
    leafName({ groupPath: ['primitive colour collection', 'key colour group'], tokenName: 'primary key colour', stripPhrases: ['key colour'] }),
    'primary',
  );
  assert.equal(leafName({ groupPath: ['colour roles'], tokenName: 'error role' }), 'error');
  assert.equal(leafName({ groupPath: ['spacing collection'], tokenName: 'base spacing' }), 'base');
});

test('never empties a name', () => {
  assert.equal(leafName({ groupPath: ['spacing'], tokenName: 'spacing' }), 'spacing');
});

test('de-duplicates colliding names', () => {
  const taken = new Set();
  assert.equal(uniqueName('--ds-a', taken).name, '--ds-a');
  assert.equal(uniqueName('--ds-a', taken).name, '--ds-a-2');
  assert.equal(uniqueName('--ds-a', taken).name, '--ds-a-3');
});

/* ------------------------------------------------------------ colour system */

test('the two tiers are emitted as separate sections', () => {
  const sectionIds = build.sections.map((section) => section.id);
  assert.ok(sectionIds.indexOf('roles') < sectionIds.indexOf('primitives'));
  const roles = build.roles.filter((role) => !role.derived);
  const primitives = build.primitives.filter((entry) => !entry.derived);
  assert.ok(roles.every((role) => role.name.startsWith('--ds-color-')));
  assert.ok(roles.every((role) => !role.name.startsWith('--ds-color-primitive-')));
  assert.ok(primitives.every((primitive) => primitive.name.startsWith('--ds-color-primitive-')));
});

test('every colour role is an alias to a primitive', () => {
  for (const role of build.roles.filter((entry) => !entry.derived)) {
    assert.equal(role.isAlias, true, `${role.tokenName} is not an alias`);
    assert.match(role.value, /^var\(--ds-color-primitive-[\w-]+\)$/);
  }
});

test('the Figma alias graph survives into CSS', () => {
  assert.match(css, /--ds-color-primary: var\(--ds-color-primitive-key-primary\);/);
  assert.match(css, /--ds-color-on-primary: var\(--ds-color-primitive-primary-100\);/);
  assert.match(css, /--ds-color-error: var\(--ds-color-primitive-error-40\);/);
});

test('roleValues=literal inlines colours instead of aliasing', () => {
  const literal = buildTokens(document, { roleValues: 'literal', source: SOURCE });
  const primary = literal.roles.find((role) => role.tokenName === 'primary');
  assert.equal(primary.isAlias, true);
  assert.equal(primary.value, 'rgb(34 21 214)');
});

test('the stylesheet teaches the two tier rule to whoever opens it', () => {
  assert.match(css, /APPLY THESE IN THE UI/);
  assert.match(css, /FOUNDATIONS ONLY - DO NOT APPLY DIRECTLY IN THE UI/);
  // Compare declarations, not the header comment, which mentions both tiers.
  const declaration = (name) => css.search(new RegExp(`^\\s+${name}:`, 'm'));
  assert.ok(declaration('--ds-color-primary') < declaration('--ds-color-primitive-primary-0'));
  assert.ok(declaration('--ds-color-primitive-error-0') < declaration('--ds-spacing-no'));
});

test('every role has a matching on-role and passes WCAG AA', () => {
  assert.equal(build.pairs.length, 8);
  for (const pair of build.pairs) {
    assert.equal(pair.passAALarge, true, `${pair.on} on ${pair.base} is ${pair.ratio}:1`);
  }
});

test('contrast maths matches known values', () => {
  assert.equal(Math.round(contrastRatio(parseColor('#000000'), parseColor('#ffffff')) * 100) / 100, 21);
  assert.equal(contrastRatio(parseColor('#000000'), parseColor('#000000')), 1);
});

test('unreferenced palettes are reported as findings, not silently dropped', () => {
  const codes = build.warnings.map((warning) => warning.code);
  assert.ok(codes.includes('palette-unused'));
  assert.ok(codes.includes('no-surface-roles'));
});

/* ------------------------------------------------------------------ values */

test('colours are normalised and channels are available', () => {
  assert.equal(variable('--ds-color-primitive-primary-60').value, 'rgb(80 69 237)');
  assert.equal(variable('--ds-color-primitive-primary-60-rgb').value, '80 69 237');
  assert.equal(variable('--ds-color-primitive-primary-100').value, 'rgb(255 255 255)');
});

test('colour format can be switched to hex', () => {
  const hex = buildTokens(document, { colorFormat: 'hex', source: SOURCE });
  assert.equal(hex.primitives.find((p) => p.name === '--ds-color-primitive-primary-60').value, '#5045ed');
});

test('a non normal blend mode is not silently dropped', () => {
  const tinted = buildTokens(
    { g: { c: { type: 'color', value: '#112233ff', blendMode: 'multiply' } } },
    { source: 'inline' },
  );
  assert.ok(tinted.warnings.some((warning) => warning.code === 'blend-mode'));
});

test('dimensions get an explicit unit and can switch to rem', () => {
  assert.equal(variable('--ds-spacing-base').value, '16px');
  assert.equal(variable('--ds-typography-headline-large-font-size').value, '32px');
  const rem = buildTokens(document, { unit: 'rem', source: SOURCE });
  assert.equal(rem.variables.find((v) => v.name === '--ds-spacing-base').value, '1rem');
  assert.equal(rem.variables.find((v) => v.name === '--ds-typography-body-large-font-size').value, '1rem');
});

test('typography expands into one variable per CSS property', () => {
  assert.equal(variable('--ds-typography-body-large-font-family').value, '"DM Sans"');
  assert.equal(variable('--ds-typography-body-large-font-weight').value, '500');
  assert.equal(variable('--ds-typography-body-large-letter-spacing').value, '-0.8px');
  assert.equal(variable('--ds-typography-body-large-line-height').value, '24px');
  assert.equal(variable('--ds-typography-body-large-text-transform').value, 'none');
  assert.equal(variable('--ds-typography-label-small-line-height').value, '16.5px');
});

test('the font shorthand is valid CSS and can be turned off', () => {
  assert.equal(variable('--ds-typography-body-large-font').value, '500 16px/24px "DM Sans"');
  const off = buildTokens(document, { fontShorthand: false, source: SOURCE });
  assert.equal(off.variables.some((v) => v.name === '--ds-typography-body-large-font'), false);
});

test('fontStack appends a fallback without changing the family', () => {
  const stacked = buildTokens(document, { fontStack: 'system-ui, sans-serif', source: SOURCE });
  assert.equal(stacked.variables.find((v) => v.name === '--ds-typography-body-large-font-family').value, '"DM Sans", system-ui, sans-serif');
});

test('shadows map Figma fields onto box-shadow', () => {
  assert.equal(variable('--ds-shadow-hard-shadow').value, '4px 6px 8px rgb(0 0 0 / 0.3216)');
  assert.equal(variable('--ds-shadow-medium-shadoww').value, '2px 4px 6px rgb(0 0 0 / 0.2784)');
  assert.equal(variable('--ds-shadow-soft-shadow').value, '2px 2px 20px rgb(0 0 0 / 0.1216)');
});

test('spacing is exported under a de-stuttered name', () => {
  assert.deepEqual(
    build.spacing.filter((entry) => !entry.derived).map((entry) => entry.name),
    [
      '--ds-spacing-no',
      '--ds-spacing-extra-small',
      '--ds-spacing-small',
      '--ds-spacing-medium',
      '--ds-spacing-base',
      '--ds-spacing-extra-large',
      '--ds-spacing-large',
      '--ds-spacing-very-large',
    ],
  );
});

/* -------------------------------------------------------------------- output */

test('the prefix survives name construction', () => {
  assert.ok(css.includes('--ds-color-primary:'), 'custom properties must start with two dashes');
  assert.equal(/^\s*-ds-/m.test(css), false);
});

test('every emitted variable is unique and well formed', () => {
  const names = build.variables.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^--[a-z0-9]+(-[a-z0-9]+)*$/);
});

test('every role references a primitive that is actually emitted', () => {
  const emitted = new Set(build.variables.map((entry) => entry.name));
  for (const role of build.roles.filter((entry) => !entry.derived)) {
    const referenced = /var\((--[\w-]+)\)/.exec(role.value);
    assert.ok(referenced, `${role.name} is not an alias`);
    assert.ok(emitted.has(referenced[1]), `${referenced[1]} is referenced but not emitted`);
  }
});

test('output is deterministic: no timestamps, no machine paths', () => {
  const first = emitCss(buildTokens(document, { source: SOURCE }), { source: SOURCE });
  const second = emitCss(buildTokens(document, { source: SOURCE }), { source: SOURCE });
  assert.equal(first, second);
  assert.equal(/[A-Za-z]:\\/.test(first), false, 'no absolute Windows paths');
  assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:/.test(first), false, 'no timestamps');
});

test('the custom prefix is applied to every variable', () => {
  const custom = buildTokens(document, { prefix: '--acme-', source: SOURCE });
  assert.ok(custom.variables.every((entry) => entry.name.startsWith('--acme-')));
  assert.equal(custom.variables.some((entry) => entry.name.startsWith('--ds-')), false);
});

test('palettes are sorted by step rather than by file order', () => {
  const steps = build.palettes
    .find((palette) => palette.title === 'Primary palette')
    .steps.map((step) => step.step);
  assert.deepEqual(steps, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 98, 99, 100]);
});

test('the JSON report is valid and traces every variable back to Figma', () => {
  const report = JSON.parse(emitReport(build, { source: SOURCE }));
  assert.equal(report.roles.length, 16);
  assert.equal(report.stats.errors, 0);
  const primary = report.variables.find((entry) => entry.variable === '--ds-color-primary');
  assert.equal(primary.sourceToken, 'colour roles.primary');
  assert.equal(primary.category, 'semantic-role');
  assert.equal(primary.figmaVariableId, 'VariableID:145:31');
});

test('the Markdown reference documents both tiers and the findings', () => {
  const markdown = emitMarkdown(build, { source: SOURCE });
  assert.match(markdown, /The one rule: roles in, primitives out/);
  assert.match(markdown, /\| `primary` \| `--ds-color-primary` \| `--ds-color-primitive-key-primary`/);
  assert.match(markdown, /Foundations only/);
  assert.match(markdown, /scale is not in ascending order|internally consistent/);
});

/* ---------------------------------------------------------------------- CLI */

test('an alias survives an unconfigured group and a forward reference', () => {
  // The role is declared before its target, and the target group is not one
  // the config describes. Neither may cost the role its indirection: that is
  // the whole point of the two tier model.
  const document = {
    'colour roles': {
      primary: { value: '{palette.brand.60}', type: 'color' },
      'on primary': { value: '#ffffff', type: 'color' },
    },
    palette: { brand: { 60: { value: '#5045ed', type: 'color' } } },
  };
  const value = (document) => {
    const build = buildTokens(document, { source: SOURCE });
    return build.roles.find((role) => role.tokenName === 'primary');
  };

  for (const role of [value(document), value({ palette: document.palette, 'colour roles': document['colour roles'] })]) {
    assert.equal(role.isAlias, true);
    assert.equal(role.value, 'var(--ds-palette-60)');
  }
  // And the pair is still measured through the indirection.
  const build = buildTokens(document, { source: SOURCE });
  assert.equal(build.pairs.length, 1);
  assert.equal(build.pairs[0].ratio, 6.15);
  assert.equal(build.pairs[0].passAA, true);
});

test('palette sorting reorders steps and keeps channels with their colour', () => {
  const document = {
    palette: {
      'b 100': { value: '#ffffff', type: 'color' },
      'b 5': { value: '#f5f5f5', type: 'color' },
      'b 20': { value: '#000000', type: 'color' },
    },
  };
  const order = (sort) =>
    emitCss(buildTokens(document, { source: SOURCE, sort }), { source: SOURCE })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('--ds'))
      .map((line) => line.slice(0, line.indexOf(':')));

  assert.deepEqual(order('palette'), [
    '--ds-palette-b-5',
    '--ds-palette-b-5-rgb',
    '--ds-palette-b-20',
    '--ds-palette-b-20-rgb',
    '--ds-palette-b-100',
    '--ds-palette-b-100-rgb',
  ]);
  assert.deepEqual(order('file'), [
    '--ds-palette-b-100',
    '--ds-palette-b-100-rgb',
    '--ds-palette-b-5',
    '--ds-palette-b-5-rgb',
    '--ds-palette-b-20',
    '--ds-palette-b-20-rgb',
  ]);
});

test('the CLI parser understands values, shorthands and negations', () => {
  const { options, seen, errors } = parseArgs([
    'custom.tokens.json',
    '-o',
    'build',
    '--color-format=hex',
    '--no-channels',
    '--unit',
    'rem',
  ]);
  assert.deepEqual(errors, []);
  // Option keys are the long flag names, exactly as declared in OPTION_SPEC.
  assert.equal(options.input, 'custom.tokens.json');
  assert.equal(options.out, 'build');
  assert.equal(options['color-format'], 'hex');
  assert.equal(options.channels, false);
  assert.equal(options.unit, 'rem');
  assert.ok(seen.has('channels'), 'an explicit --no- flag must count as seen so it overrides the config file');
  assert.ok(seen.has('color-format'));
  assert.equal(seen.has('sort'), false, 'untouched options must not override the config file');
});

test('the CLI parser rejects bad input', () => {
  assert.match(parseArgs(['--unit', 'furlongs']).errors[0], /expects one of/);
  assert.match(parseArgs(['--nonsense']).errors[0], /Unknown option/);
  assert.match(parseArgs(['--unit']).errors[0], /expects a value/);
});
