/**
 * build.mjs
 * ---------------------------------------------------------------------------
 * The core of the converter. Pure data in, pure data out: it never touches the
 * file system, so it can be unit tested and reused by other tooling.
 *
 * The single most important rule of this design system lives here. The colour
 * model has two tiers, and they are emitted into two separate sections:
 *
 *   semantic roles     `--ds-color-primary`              APPLY IN THE UI
 *        |
 *        |  aliased to
 *        v
 *   primitive colours  `--ds-color-primitive-primary-60` FOUNDATIONS ONLY
 *
 * By default a role is emitted as `var(--ds-color-primitive-...)` rather than
 * as a duplicated literal, so the alias graph authored in Figma survives into
 * CSS: re-pointing one primitive re-themes everything downstream of it. Pass
 * `roleValues: 'literal'` to inline the resolved colour instead.
 */

import { contrastRatio, parseColor, toHex, CONTRAST_LEVELS } from './color.mjs';
import { compareByStep, kebab, leafName, matchGroup, stepOf, uniqueName } from './naming.mjs';
import { createFormatter, TYPOGRAPHY_ORDER, TYPOGRAPHY_PROPERTIES } from './format.mjs';
import { flattenTokens, resolveTokens } from './parse.mjs';
import { validate } from './validate.mjs';

/**
 * Built-in group configuration. Mirrors `tokens.build.config.json`; a project
 * config file is merged over the top of this, so prefixes can be renamed
 * without touching code.
 */
export const DEFAULT_GROUP_CONFIG = {
  effect: { prefix: 'shadow', title: 'Shadows / effects', section: 'shadows' },
  'primitive colour collection': {
    prefix: 'color-primitive',
    title: 'Primitive colour foundations',
    section: 'primitives',
  },
  'primitive colour collection.key colour group': {
    prefix: 'color-primitive-key',
    stripPhrases: ['key colour'],
    title: 'Key colours',
    section: 'primitives',
  },
  'primitive colour collection.primary colour palette': {
    prefix: 'color-primitive-primary',
    title: 'Primary palette',
    section: 'primitives',
  },
  'primitive colour collection.secondary colour palette': {
    prefix: 'color-primitive-secondary',
    title: 'Secondary palette',
    section: 'primitives',
  },
  'primitive colour collection.tertiary colour palette': {
    prefix: 'color-primitive-tertiary',
    title: 'Tertiary palette',
    section: 'primitives',
  },
  'primitive colour collection.neutral colour palette': {
    prefix: 'color-primitive-neutral',
    title: 'Neutral palette',
    section: 'primitives',
  },
  'primitive colour collection.neutral variant colour palette': {
    prefix: 'color-primitive-neutral-variant',
    title: 'Neutral variant palette',
    section: 'primitives',
  },
  'primitive colour collection.error colour palette': {
    prefix: 'color-primitive-error',
    title: 'Error palette',
    section: 'primitives',
  },
  'colour roles': { prefix: 'color', title: 'Semantic colour roles', section: 'roles' },
  'spacing collection': { prefix: 'spacing', title: 'Spacing scale', section: 'spacing' },
  typography: { prefix: 'typography', title: 'Typography', section: 'typography' },
};

/** Token types the formatter understands. Anything else produces a warning. */
const KNOWN_TYPES = new Set([
  'color',
  'dimension',
  'number',
  'string',
  'boolean',
  'typography',
  'custom-shadow',
  'shadow',
  'boxShadow',
]);

const SHADOW_TYPES = new Set(['custom-shadow', 'shadow', 'boxShadow']);

/** Section order in the generated CSS. Roles deliberately come first. */
export const SECTION_ORDER = ['roles', 'primitives', 'spacing', 'typography', 'shadows'];

const SECTION_META = {
  roles: {
    title: 'Semantic colour roles',
    usage: 'APPLY THESE IN THE UI',
    banner: [
      'These variables describe intent, not appearance. `--ds-color-primary` stays',
      "whatever the brand colour is; a dark theme, a high contrast theme or a",
      'per-tenant rebrand only has to re-point this block, never the components.',
    ],
  },
  primitives: {
    title: 'Primitive colour foundations',
    usage: 'FOUNDATIONS ONLY - DO NOT APPLY DIRECTLY IN THE UI',
    banner: [
      'Raw palette values. They exist so the roles above have a single source of',
      'truth and can be re-pointed without hunting through code. Referencing one',
      'of these from a component hard-codes a colour into the UI and breaks the',
      'theming contract - always use a role instead.',
    ],
  },
  spacing: {
    title: 'Spacing scale',
    usage: 'LAYOUT - GAP, PADDING, MARGIN',
    banner: ['A deliberately short scale. Two steps per jump keeps rhythm consistent.'],
  },
  typography: {
    title: 'Typography',
    usage: 'TEXT STYLES',
    banner: [
      'One variable per CSS property, plus a `font` shorthand for the common case:',
      '`font: var(--ds-typography-body-large-font)`.',
    ],
  },
  shadows: {
    title: 'Shadows / effects',
    usage: 'ELEVATION',
    banner: ['Figma layer effects flattened to `box-shadow`. Figma "radius" maps to CSS blur.'],
  },
};

/**
 * Build the complete variable model.
 *
 * @param {object} document parsed token JSON
 * @param {object} options see README > Configuration
 * @returns {object} build result consumed by every emitter
 */
export function buildTokens(document, options = {}) {
  const config = {
    prefix: '--ds-',
    unit: 'px',
    rootSize: 16,
    colorFormat: 'modern',
    roleValues: 'alias',
    fontStack: '',
    channels: true,
    alphaVars: false,
    fontShorthand: true,
    sort: 'palette',
    groups: {},
    ...options,
  };
  const customGroups = options.groups ?? {};
  config.groups = { ...DEFAULT_GROUP_CONFIG };
  for (const [key, value] of Object.entries(customGroups)) {
    // Merge per key so a project config only has to state what it changes;
    // `section` and the built-in prefix survive unless they are overridden.
    config.groups[key] = { ...(DEFAULT_GROUP_CONFIG[key] ?? {}), ...value };
  }

  const formatter = createFormatter(config);
  const { tokens, groups: groupPaths } = flattenTokens(document);
  const { resolved, issues } = resolveTokens(tokens);

  const state = {
    config,
    formatter,
    tokens,
    resolved,
    warnings: [...issues],
    taken: new Set(),
    variables: [],
    sections: new Map(SECTION_ORDER.map((id) => [id, { id, ...SECTION_META[id], entries: [] }])),
  };

  const scalars = tokens.filter((token) => token.kind !== 'composite' && token.kind !== 'style-group');
  const composites = tokens.filter((token) => token.kind === 'composite' || token.kind === 'style-group');

  /** @type {object[]} */
  const roles = [];
  /** @type {object[]} */
  const primitives = [];
  /** @type {object[]} */
  const spacing = [];
  /** @type {object[]} */
  const shadows = [];
  /** @type {object[]} */
  const typography = [];

  for (const token of scalars) emitScalar({ state, token, roles, primitives, spacing });
  for (const token of composites) {
    const resolution = state.resolved.get(token.pathString);
    if (resolution.dangling) continue;
    if (token.type === 'typography') typography.push(emitTypographyStyle({ state, token, resolution }));
    else if (SHADOW_TYPES.has(token.type)) shadows.push(emitShadow({ state, token, resolution }));
    else
      state.warnings.push({
        code: 'unsupported-composite',
        level: 'warn',
        token: token.pathString,
        message: `Composite type "${token.type}" has no CSS mapping yet and was skipped.`,
      });
  }

  if (config.sort === 'palette') sortSectionsByStep(state.sections);

  const palettes = collectPalettes(primitives, state.resolved);
  const usage = collectRoleUsage(roles);
  const pairs = collectContrastPairs(roles, state.warnings);

  state.warnings.push(...validate({ tokens, state, roles, primitives, pairs }));

  const variables = state.variables;
  return {
    config,
    source: options.source ?? null,
    sections: [...state.sections.values()],
    variables,
    tokens,
    groups: groupPaths,
    roles,
    primitives,
    spacing,
    typography,
    shadows,
    palettes,
    pairs,
    usage,
    warnings: state.warnings,
    stats: {
      tokens: tokens.length,
      groups: groupPaths.length,
      variables: variables.length,
      roles: roles.length,
      primitives: primitives.filter((entry) => !entry.derived).length,
      spacing: spacing.length,
      typographyStyles: typography.length,
      typographyVariables: typography.reduce((sum, style) => sum + style.variables.length, 0),
      shadows: shadows.length,
      pairs: pairs.length,
      warnings: state.warnings.filter((w) => w.level === 'warn').length,
      errors: state.warnings.filter((w) => w.level === 'error').length,
      infos: state.warnings.filter((w) => w.level === 'info').length,
    },
  };
}

/* ------------------------------------------------------------------ scalars */

function emitScalar({ state, token, roles, primitives, spacing }) {
  const { config, formatter, warnings } = state;
  const resolution = state.resolved.get(token.pathString);
  if (resolution.dangling) return;

  const group = resolveGroup(config, token);
  const section = group.config.section ?? 'other';
  const name = claimName(state, token, group.config, token.name, config);
  const target = token.kind === 'reference' ? variableNameOf(state, resolution.reference) : null;

  const entry = {
    name,
    tokenPath: token.pathString,
    tokenName: token.name,
    group: group.key,
    groupTitle: group.config.title ?? '',
    section,
    type: token.type,
    description: token.description,
    figma: token.figma,
    rawValue: token.value,
    isAlias: token.kind === 'reference',
    alias: resolution.reference,
    aliasTarget: target,
    primitiveName: section === 'roles' ? resolution.reference : null,
    color: null,
    derived: null,
  };

  if (target && config.roleValues === 'alias') {
    entry.value = `var(${target})`;
  } else {
    entry.value = formatScalar(token, resolution.value, formatter, warnings);
  }

  if (token.type === 'color') {
    entry.color = parseColor(resolution.value);
    entry.colorHex = entry.color ? toHex(entry.color) : null;
    entry.suggestedProperty = 'color';
  } else if (token.type === 'dimension') {
    entry.suggestedProperty = /\bspacing\b/i.test(token.name) ? 'padding' : 'width';
  }

  if (token.figma?.blendMode && token.figma.blendMode !== 'normal') {
    warnings.push({
      code: 'blend-mode',
      level: 'warn',
      token: token.pathString,
      message: `Blend mode "${token.figma.blendMode}" has no CSS equivalent on a custom property; the raw colour was emitted.`,
    });
  }

  push(state, entry);
  sectionOf(state, section).entries.push(entry);
  if (section === 'roles') roles.push(entry);
  else if (section === 'primitives') primitives.push(entry);
  else if (section === 'spacing') spacing.push(entry);

  if (!entry.color) return;

  // `-rgb` companions let components build translucent overlays without
  // hard-coding a channel triple: rgb(var(--ds-color-primary-rgb) / 12%).
  if (config.channels) {
    const channelsName = claimDerivedName(state, `${name}-rgb`);
    const channels = {
      ...entry,
      name: channelsName,
      value: `${entry.color.r} ${entry.color.g} ${entry.color.b}`,
      isAlias: false,
      alias: null,
      aliasTarget: null,
      primitiveName: null,
      color: null,
      colorHex: null,
      suggestedProperty: null,
      derived: 'channels',
      description: `RGB channels of ${name}. Compose with rgb(${channelsName} / 50%).`,
    };
    push(state, channels);
    sectionOf(state, section).entries.push(channels);
  }

  if (config.alphaVars && entry.color.a < 1) {
    const alpha = {
      ...entry,
      name: claimDerivedName(state, `${name}-alpha`),
      value: String(Number.parseFloat(entry.color.a.toFixed(4))),
      isAlias: false,
      alias: null,
      aliasTarget: null,
      primitiveName: null,
      color: null,
      colorHex: null,
      suggestedProperty: null,
      derived: 'alpha',
      description: `Alpha channel of ${name}, 0-1.`,
    };
    push(state, alpha);
    sectionOf(state, section).entries.push(alpha);
  }
}

/* -------------------------------------------------------------- composites */

function emitShadow({ state, token, resolution }) {
  const { config, formatter } = state;
  const group = resolveGroup(config, token);
  const section = group.config.section ?? 'other';
  const name = claimName(state, token, group.config, token.name, config);
  const shadow = formatter.shadow(resolution.value);

  if (!shadow) {
    state.warnings.push({
      code: 'empty-shadow',
      level: 'warn',
      token: token.pathString,
      message: 'Shadow token has no usable layers and was skipped.',
    });
    return null;
  }

  const entry = {
    name,
    tokenPath: token.pathString,
    tokenName: token.name,
    group: group.key,
    groupTitle: group.config.title ?? '',
    section,
    type: token.type,
    description: token.description,
    figma: token.figma,
    rawValue: token.value,
    value: shadow.value,
    isAlias: false,
    alias: null,
    aliasTarget: null,
    color: null,
    colorHex: null,
    derived: null,
    suggestedProperty: 'box-shadow',
    shadow: resolution.value,
  };
  push(state, entry);
  sectionOf(state, section).entries.push(entry);
  return entry;
}

function emitTypographyStyle({ state, token, resolution }) {
  const { config, formatter } = state;
  const group = resolveGroup(config, token);
  const section = group.config.section ?? 'other';
  const base = leafName({ groupPath: token.groupPath, tokenName: token.name, stripPhrases: group.config.stripPhrases ?? [] });
  const subTokens = resolution.value ?? {};
  const ordered = [
    ...TYPOGRAPHY_ORDER.filter((key) => key in subTokens),
    ...Object.keys(subTokens).filter((key) => !TYPOGRAPHY_ORDER.includes(key)),
  ];

  const variables = [];
  for (const key of ordered) {
    const spec = TYPOGRAPHY_PROPERTIES[key];
    if (!spec) {
      state.warnings.push({
        code: 'unknown-typography-property',
        level: 'warn',
        token: `${token.pathString}.${key}`,
        message: `Typographic property "${key}" has no CSS mapping and was skipped.`,
      });
      continue;
    }
    const formatted = formatter.typographyProperty(key, subTokens[key]);
    if (formatted === null) continue;
    const entry = {
      name: variableName(config.prefix, group.config.prefix, base, spec.property),
      tokenPath: `${token.pathString}.${key}`,
      tokenName: `${token.name} / ${key}`,
      group: group.key,
      groupTitle: group.config.title ?? '',
      section,
      type: typeof subTokens[key] === 'number' ? 'number' : 'string',
      description: token.description,
      figma: token.figma,
      rawValue: subTokens[key],
      value: formatted.value,
      isAlias: false,
      alias: null,
      aliasTarget: null,
      color: null,
      colorHex: null,
      derived: null,
      cssProperty: spec.property,
      sourceProperty: key,
      style: token.name,
      suggestedProperty: spec.property,
    };
    push(state, entry);
    sectionOf(state, section).entries.push(entry);
    variables.push(entry);
  }

  if (config.fontShorthand) {
    const shorthand = formatter.fontShorthand(subTokens);
    if (shorthand) {
      const entry = {
        name: variableName(config.prefix, group.config.prefix, base, 'font'),
        tokenPath: token.pathString,
        tokenName: `${token.name} / shorthand`,
        group: group.key,
        groupTitle: group.config.title ?? '',
        section,
        type: 'string',
        description: 'font shorthand for this text style.',
        figma: token.figma,
        rawValue: null,
        value: shorthand,
        isAlias: false,
        alias: null,
        aliasTarget: null,
        color: null,
        colorHex: null,
        derived: null,
        cssProperty: 'font',
        style: token.name,
        suggestedProperty: 'font',
      };
      push(state, entry);
      sectionOf(state, section).entries.push(entry);
      variables.unshift(entry);
    }
  }

  return { name: token.name, tokenPath: token.pathString, variables, properties: subTokens };
}

/* ------------------------------------------------------------------ helpers */

/**
 * Assemble a custom property name.
 *
 * The prefix is never sanitised (it is the one part that legitimately starts
 * with `--`); only the group prefix and the leaf are kebab-cased and joined,
 * which is what keeps `--ds-` from collapsing into `-ds-`.
 */
function variableName(prefix, groupPrefix, ...parts) {
  const tail = [groupPrefix, ...parts].map(kebab).filter(Boolean).join('-');
  return `${prefix}${tail}`;
}

function resolveGroup(config, token) {
  const match = matchGroup(config.groups, token.groupPath);
  if (match.key) return { key: match.key, config: match.config };
  const fallback = leafName({ groupPath: token.groupPath, tokenName: token.groupPath.join(' ') }) || 'token';
  return { key: token.groupPath.join('.'), config: { prefix: fallback, title: token.groupPath.join(' / '), section: 'other' } };
}

function claimName(state, token, groupConfig, tokenName, config) {
  const leaf = leafName({
    groupPath: token.groupPath,
    tokenName,
    stripPhrases: groupConfig.stripPhrases ?? [],
  });
  const { name, suffixed } = uniqueName(variableName(config.prefix, groupConfig.prefix, leaf), state.taken);
  if (suffixed) {
    state.warnings.push({
      code: 'name-collision',
      level: 'warn',
      token: token.pathString,
      message: `Several tokens normalise to "${name}". Rename the Figma tokens to keep the CSS predictable.`,
    });
  }
  return name;
}

/** Claim a name for a derived companion variable (`-rgb`, `-alpha`). */
function claimDerivedName(state, desired) {
  const { name } = uniqueName(desired, state.taken);
  return name;
}

function push(state, entry) {
  if (state.variables.some((variable) => variable.name === entry.name)) {
    state.warnings.push({
      code: 'duplicate-variable',
      level: 'warn',
      token: entry.tokenPath,
      message: `${entry.name} is already defined; this duplicate was skipped.`,
    });
    return null;
  }
  state.variables.push(entry);
  return entry;
}

function sectionOf(state, id) {
  if (!state.sections.has(id)) {
    state.sections.set(id, { id, title: id, usage: '', banner: [], entries: [] });
  }
  return state.sections.get(id);
}

function formatScalar(token, value, formatter, warnings) {
  switch (token.type) {
    case 'color': {
      const rgba = parseColor(value);
      if (!rgba) {
        warnings.push({
          code: 'unparseable-color',
          level: 'warn',
          token: token.pathString,
          message: `Colour value "${value}" is not a known notation; it was emitted verbatim.`,
        });
      }
      return formatter.color(value, { native: value });
    }
    case 'dimension':
      return formatter.dimension(value);
    case 'number':
    case 'string':
    case 'boolean':
      return formatter.raw(value);
    default:
      if (token.type && !KNOWN_TYPES.has(token.type)) {
        warnings.push({
          code: 'unknown-type',
          level: 'warn',
          token: token.pathString,
          message: `Unknown token type "${token.type}"; the raw value was emitted.`,
        });
      }
      return formatter.raw(value);
  }
}

/**
 * The CSS variable name of the token an alias points at.
 * Aliases may point forward, so this also recomputes the name with the same
 * rules used at emit time instead of relying on an already-emitted variable.
 */
function variableNameOf(state, referencePath) {
  if (!referencePath) return null;
  const emitted = state.variables.find((variable) => variable.tokenPath === referencePath);
  if (emitted) return emitted.name;
  const target = state.tokens.find((token) => token.pathString === referencePath);
  if (!target) return null;
  // Resolve through resolveGroup, fallback included, so this agrees with
  // emitScalar by construction. Bailing on an unconfigured group here would
  // quietly turn every role pointing into that group into a hard-coded
  // literal, which is exactly the failure the alias model exists to prevent.
  const group = resolveGroup(state.config, target);
  const leaf = leafName({
    groupPath: target.groupPath,
    tokenName: target.name,
    stripPhrases: group.config.stripPhrases ?? [],
  });
  return variableName(state.config.prefix, group.config.prefix, leaf);
}

/**
 * Put a palette back into ascending step order regardless of the order it
 * happens to sit in the token file.
 *
 * Two details matter. `stepOf` matches a trailing `-<digits>`, so it has to be
 * handed the whole variable name, not the last name segment. And a variable's
 * derived companions (`-rgb`, `-alpha`) belong next to the colour they
 * describe, so entries are sorted in units of "primary plus its companions"
 * rather than one at a time.
 *
 * Sections that are not palettes -- the role block, the key colour group --
 * have no trailing step on every entry, so they are left in file order.
 */
function sortSectionsByStep(sections) {
  for (const section of sections.values()) {
    const units = chunkByPrimary(section.entries);
    if (units.length < 2) continue;
    if (!units.every((unit) => stepOf(unit[0].name) !== null)) continue;
    units.sort((a, b) =>
      compareByStep({ step: stepOf(a[0].name), name: a[0].name }, { step: stepOf(b[0].name), name: b[0].name }),
    );
    section.entries = units.flat();
  }
}

/** Group entries into `[primary, ...derived]` units, tolerating stray derived entries. */
function chunkByPrimary(entries) {
  const units = [];
  let current = null;
  for (const entry of entries) {
    if (!entry.derived || current === null) {
      current = [entry];
      units.push(current);
    } else {
      current.push(entry);
    }
  }
  return units;
}

/** Group primitive colours into palettes for the documentation output. */
function collectPalettes(primitives, resolved) {
  const palettes = new Map();
  for (const entry of primitives) {
    if (entry.derived) continue;
    if (!palettes.has(entry.group)) {
      palettes.set(entry.group, {
        key: entry.group,
        title: entry.groupTitle || entry.group,
        baseVariable: entry.name.replace(/-\d+(-rgb)?$/, ''),
        steps: [],
      });
    }
    const stepMatch = /-(\d+)(-rgb)?$/.exec(entry.name);
    palettes.get(entry.group).steps.push({
      step: stepMatch && !stepMatch[2] ? Number(stepMatch[1]) : null,
      name: entry.tokenName,
      variable: entry.name,
      hex: entry.colorHex,
      color: entry.color,
    });
  }

  // Which role (if any) points into each palette. Palettes with no roles are
  // foundations waiting for a role, which the report calls out explicitly.
  const referenced = new Set();
  for (const resolution of resolved.values()) {
    if (resolution.reference) referenced.add(resolution.reference.split('.').slice(0, 2).join('.'));
  }

  return [...palettes.values()].map((palette) => ({
    ...palette,
    steps: palette.steps.sort((a, b) => compareByStep(a, b)),
    usedByRoles: [...referenced].filter((path) => path.startsWith(palette.key)),
  }));
}

/** Reverse index: primitive token path -> the roles that consume it. */
function collectRoleUsage(roles) {
  const usage = new Map();
  for (const role of roles) {
    if (!role.primitiveName) continue;
    const list = usage.get(role.primitiveName) ?? [];
    list.push(role.tokenName);
    usage.set(role.primitiveName, list);
  }
  return {
    byPrimitive: Object.fromEntries(usage),
    byVariable: Object.fromEntries(roles.map((role) => [role.name, role.tokenName])),
  };
}

/**
 * Pair every colour role with its `on -` counterpart and measure WCAG
 * contrast. This is the check that catches a role pointing at the wrong
 * palette step before it reaches production.
 */
function collectContrastPairs(roles, warnings) {
  const byName = new Map(roles.map((entry) => [entry.tokenName, entry]));
  const pairs = [];

  for (const entry of roles) {
    const match = /^on (.+)$/.exec(entry.tokenName);
    if (!match) continue;
    const base = byName.get(match[1]);
    if (!base) {
      warnings.push({
        code: 'orphan-on-role',
        level: 'warn',
        token: entry.tokenPath,
        message: `Role "${entry.tokenName}" has no matching "${match[1]}" role to sit on.`,
      });
      continue;
    }
    if (!base.color || !entry.color) continue;

    const ratio = contrastRatio(entry.color, base.color);
    pairs.push({
      base: base.tokenName,
      on: entry.tokenName,
      baseVariable: base.name,
      onVariable: entry.name,
      baseHex: base.colorHex,
      onHex: entry.colorHex,
      ratio: Number.parseFloat(ratio.toFixed(2)),
      passAA: ratio >= CONTRAST_LEVELS.AA_TEXT,
      passAALarge: ratio >= CONTRAST_LEVELS.AA_LARGE_TEXT,
      passAAA: ratio >= CONTRAST_LEVELS.AAA_TEXT,
    });
  }
  return pairs;
}
