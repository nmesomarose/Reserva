/**
 * validate.mjs
 * ---------------------------------------------------------------------------
 * Design-system linting. Everything here is a judgement call a compiler cannot
 * make for you, so each rule is written down with the reason it exists.
 *
 * Severity
 *   error  the build is wrong: a reference does not resolve, a cycle exists
 *   warn   the build works but something is worth fixing in Figma
 *   info   a finding, not a defect (an unused palette, a probable typo)
 *
 * These findings are surfaced three times: on the console, in
 * `dist/tokens.report.json` and in the generated `TOKENS.md`, so they cannot be
 * quietly lost between a designer and a front-end developer.
 */

import { CONTRAST_LEVELS } from './color.mjs';

const WORD = '[A-Za-z]{3,}';

/**
 * @param {object} args
 * @param {object[]} args.tokens
 * @param {object} args.state   the mutable build state (resolved map, config-)
 * @param {object[]} args.roles
 * @param {object[]} args.primitives
 * @param {object[]} args.pairs contrast pairs collected by the builder
 * @returns {object[]} findings
 */
export function validate({ tokens, state, roles, primitives, pairs }) {
  const findings = [];
  const add = (level, code, token, message) => findings.push({ level, code, token, message });

  /* ------------------------------------------------- colour system integrity */

  // 1. A role that hard-codes a colour instead of aliasing a primitive has
  //    escaped the two tier model and can no longer be re-themed centrally.
  for (const role of roles) {
    if (!role.isAlias) {
      add(
        'warn',
        'role-not-aliased',
        role.tokenPath,
        `Colour role "${role.tokenName}" holds a literal ${role.colorHex ?? role.value}. Roles should reference a primitive so the palette can change in one place.`,
      );
    }
  }

  // 2. Every "on x" role needs a partner that it can actually sit on, and
  //    that pair needs to be legible.
  for (const pair of pairs) {
    if (pair.passAALarge) continue;
    const target = pair.passAA ? CONTRAST_LEVELS.AA_LARGE_TEXT : CONTRAST_LEVELS.AA_TEXT;
    add(
      'warn',
      'contrast',
      pair.on,
      `"${pair.on}" (${pair.onHex}) on "${pair.base}" (${pair.baseHex}) is ${pair.ratio}:1. WCAG AA needs ${CONTRAST_LEVELS.AA_TEXT}:1 for body text and ${CONTRAST_LEVELS.AA_LARGE_TEXT}:1 for large text; the target here is ${target}:1.`,
    );
  }

  // 3. A primitive that no role consumes is a colour nobody can reach through
  //    the semantic layer. Reported per palette rather than per step: "step 70
  //    is unused" is noise, "the neutral palette has no role at all" is a
  //    design finding.
  const usedPrimitivePaths = new Set(roles.map((role) => role.primitiveName).filter(Boolean));
  const palettes = new Map();
  for (const primitive of primitives) {
    if (primitive.derived) continue;
    const bucket = palettes.get(primitive.group) ?? { group: primitive.group, title: primitive.groupTitle, steps: [] };
    bucket.steps.push(primitive);
    palettes.set(primitive.group, bucket);
  }

  for (const bucket of palettes.values()) {
    const used = bucket.steps.filter((step) => usedPrimitivePaths.has(step.tokenPath));
    if (used.length === 0) {
      add(
        'info',
        'palette-unused',
        bucket.group,
        `No colour role references ${bucket.title ?? bucket.group} (${bucket.steps.length} steps). It is a foundation with no semantic entry point yet.`,
      );
      continue;
    }
    // Small groups are worth auditing individually; a 14 step palette is not.
    if (bucket.steps.length > 8) continue;
    const unused = bucket.steps.filter((step) => !usedPrimitivePaths.has(step.tokenPath));
    if (unused.length === 0) continue;
    add(
      'info',
      'primitives-unused',
      bucket.group,
      `${unused.length} of ${bucket.steps.length} values in ${bucket.title ?? bucket.group} have no role pointing at them: ${unused.map((step) => step.tokenName).join(', ')}.`,
    );
  }

  // 4. A role set with no surface/background roles is the most common gap in a
  //    brand palette that was never turned into a product theme.
  const roleNames = roles.map((role) => role.tokenName);
  const hasSurfaceRoles = roleNames.some((name) => /surface|background|outline|scrim/i.test(name));
  if (!hasSurfaceRoles && roles.length > 0) {
    add(
      'info',
      'no-surface-roles',
      'colour roles',
      'No surface, background or outline roles exist. Components will have to reach for a primitive for page backgrounds and borders; consider adding `background`, `surface`, `outline` roles to the token set.',
    );
  }

  // 5. A `- container` role without its `on - container` counterpart leaves
  //    designers with no approved foreground for the container.
  for (const role of roles) {
    if (role.tokenName.startsWith('on ')) continue;
    if (!role.tokenName.endsWith('container')) continue;
    const expected = `on ${role.tokenName}`;
    if (roleNames.includes(expected)) continue;
    add('info', 'missing-on-container', role.tokenPath, `Container role "${role.tokenName}" has no "${expected}" role.`);
  }

  /* ----------------------------------------------------------- token hygiene */

  // 6. Probable typos in token names. Only patterns with no false positives
  //    are flagged: a repeated word, or a run of three identical characters.
  for (const token of tokens) {
    if (/(\w)\1\1/.test(token.name) || new RegExp(`\\b(${WORD})\\s+\\1\\b`, 'i').test(token.name)) {
      add('info', 'name-typo', token.pathString, `"${token.name}" looks like it contains a duplicated character or word. It will appear in the generated CSS as-is.`);
    }
  }

  // 7. References that point at another alias are legal but hide the real
  //    source; surfacing chains longer than one hop keeps the indirection honest.
  for (const [path, resolution] of state.resolved) {
    if (!resolution.chain || resolution.chain.length < 2) continue;
    add(
      'info',
      'chained-reference',
      path,
      `Resolves through ${resolution.chain.length + 1} hops: ${resolution.chain.join(' -> ')}.`,
    );
  }

  /* -------------------------------------------------------------- value sanity */

  // 8. A spacing scale that is not ascending in file order is a data bug: it
  //    means the names and the numbers disagree, so nobody can predict what
  //    `--ds-spacing-large` is worth without looking it up.
  const spacingValues = state.variables
    .filter((variable) => variable.section === 'spacing' && !variable.derived && /^[\d.]+(px|rem)$/.test(variable.value))
    .map((variable) => ({ name: variable.name, value: Number.parseFloat(variable.value) }));
  for (let index = 1; index < spacingValues.length; index += 1) {
    const previous = spacingValues[index - 1];
    const current = spacingValues[index];
    if (current.value >= previous.value) continue;
    add(
      'warn',
      'scale-not-monotonic',
      current.name,
      `The spacing scale is not in ascending order: ${current.name} is ${current.value} but ${previous.name}, listed before it, is ${previous.value}.`,
    );
  }

  for (const token of tokens) {
    if (token.type === 'dimension' && typeof token.value === 'number' && token.value < 0) {
      add('warn', 'negative-dimension', token.pathString, `Dimension ${token.value} is negative; check whether this should be a signed letter-spacing instead.`);
    }
    if (token.type === 'fontWeight' || (token.type === 'number' && /weight/i.test(token.name))) {
      const value = Number(token.value);
      if (!Number.isNaN(value) && ![100, 200, 300, 400, 500, 600, 700, 800, 900].includes(value)) {
        add('info', 'unusual-font-weight', token.pathString, `Font weight ${value} is not a standard step; it will be resolved to the closest available face.`);
      }
    }
  }

  /* ------------------------------------------------------------------ dedupe */

  const seen = new Map();
  for (const variable of state.variables) {
    if (variable.derived) continue;
    if (seen.has(variable.name)) {
      add('warn', 'duplicate-variable', variable.tokenPath, `${variable.name} collides with ${seen.get(variable.name)}.`);
    } else {
      seen.set(variable.name, variable.tokenPath);
    }
  }

  return findings;
}
