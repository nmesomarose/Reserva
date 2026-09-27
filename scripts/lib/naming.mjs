/**
 * naming.mjs
 * ---------------------------------------------------------------------------
 * Turns human token names into predictable CSS custom property names.
 *
 * The source names come from Figma and are not CSS shaped: they contain
 * spaces, lower case British spelling and inconsistent separators
 * (`primary 0` vs `secondary0`). The rules below are deliberately boring and
 * fully deterministic so that renaming a token in Figma produces a stable,
 * reviewable diff in the generated CSS.
 *
 * Rules
 * -----
 * R0  kebab-case      `fontSize` -> `font-size`, `hard shadow` -> `hard-shadow`,
 *                     `secondary0` -> `secondary-0`
 * R1  group prefix    each group maps to a configured prefix:
 *                     `colour roles` -> `color`, so a token at
 *                     `colour roles / on primary` becomes `--ds-color-on-primary`
 * R2  de-stutter      words repeated between the group name and the token name
 *                     are dropped once: group `primary colour palette` + token
 *                     `primary 60` -> `--ds-color-primitive-primary-60`
 * R3  de-generic     trailing generic words are dropped:
 *                     `error role` -> `error`, `base spacing` -> `base`
 * R4  strip phrases  configured phrases are removed from the token name:
 *                     `primary key colour` -> `primary`
 * R5  de-duplicate   collisions get a numeric suffix (`-2`, `-3`, ...) and a
 *                     validator warning, never a silent overwrite
 */

/**
 * Words that carry no meaning on their own. They are ignored when looking for
 * repeated words between a group and its tokens (R2/R3) so that a group called
 * `spacing collection` does not strip the `spacing` a token needs to read well
 * in other contexts.
 */
export const GENERIC_WORDS = new Set([
  'colour',
  'color',
  'palette',
  'collection',
  'group',
  'scale',
  'ramp',
  'shade',
  'tint',
  'role',
  'roles',
  'token',
  'tokens',
  'value',
  'values',
  'style',
  'styles',
]);

/**
 * R0 - convert any token name fragment to kebab-case.
 *
 * @param {string} value
 * @returns {string}
 */
export function kebab(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([A-Za-z])(\d+)/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/**
 * Extract the palette step from a kebab-cased name (`primary-60` -> 60).
 *
 * @param {string} kebabName
 * @returns {number|null}
 */
export function stepOf(kebabName) {
  const match = /-(\d+)$/.exec(kebabName);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * R2 - meaningful (non generic) words of a group name, in order.
 *
 * @param {string[]} groupPath
 * @returns {string[]}
 */
export function groupKeywords(groupPath) {
  return groupWords(groupPath).filter((word) => !GENERIC_WORDS.has(word));
}

/**
 * Every word in a group name, generic or not.
 *
 * @param {string[]} groupPath
 * @returns {string[]}
 */
export function groupWords(groupPath) {
  const words = [];
  for (const segment of groupPath) {
    for (const word of kebab(segment).split('-')) {
      if (word) words.push(word);
    }
  }
  return words;
}

/**
 * R2 + R3 + R4 - shorten a token name using its group's vocabulary.
 *
 * R2 drops leading words the group already says (`primary colour palette` +
 * `primary 60` -> `60`).
 * R3 drops a trailing word the group already says or that is pure filler
 * (`spacing collection` + `base spacing` -> `base`, `colour roles` +
 * `error role` -> `error`).
 * R4 removes configured phrases (`key colour group` + `primary key colour` ->
 * `primary`).
 *
 * Neither rule can empty a name: they only fire while more than one word is
 * left, so a token called `spacing` inside a group called `spacing` survives.
 *
 * @param {object} options
 * @param {string[]} options.groupPath  e.g. `['primitive colour collection', 'primary colour palette']`
 * @param {string}   options.tokenName  e.g. `'primary 60'`
 * @param {string[]} [options.stripPhrases] phrases removed from the name, e.g. `['key colour']`
 * @returns {string} kebab-cased leaf name, e.g. `'60'`
 */
export function leafName({ groupPath, tokenName, stripPhrases = [] }) {
  let name = kebab(tokenName);
  if (!name) return '';

  for (const phrase of stripPhrases) {
    const kebabPhrase = kebab(phrase);
    if (!kebabPhrase) continue;
    // Remove the phrase wherever it appears as whole words, keeping the name readable.
    const pattern = new RegExp(`(^|-)${kebabPhrase}(?=-|$)`, 'g');
    name = name.replace(pattern, '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  }

  const words = name.split('-').filter(Boolean);
  if (words.length === 0) return '';

  const keywords = groupKeywords(groupPath);
  const allGroupWords = groupWords(groupPath);

  // R2 - drop leading words that merely repeat the group name.
  while (words.length > 1 && keywords.includes(words[0])) words.shift();

  // R3 - drop a trailing generic word (`error role` -> `error`) or one the
  //      group name already carries (`base spacing` -> `base`).
  const last = words[words.length - 1];
  if (words.length > 1 && (GENERIC_WORDS.has(last) || allGroupWords.includes(last))) words.pop();

  return words.join('-');
}

/**
 * R5 - guarantee unique CSS custom property names inside one build.
 *
 * @param {string} name desired name (without the leading `--`)
 * @param {Set<string>} taken names already used in this build
 * @returns {{ name: string, suffixed: boolean }}
 */
export function uniqueName(name, taken) {
  if (!taken.has(name)) {
    taken.add(name);
    return { name, suffixed: false };
  }
  let counter = 2;
  let candidate = `${name}-${counter}`;
  while (taken.has(candidate)) {
    counter += 1;
    candidate = `${name}-${counter}`;
  }
  taken.add(candidate);
  return { name: candidate, suffixed: true };
}

/**
 * Longest-prefix lookup for the group configuration. `key colour group` must
 * win over `primitive colour collection`, hence the sort by segment count.
 *
 * @param {object} groups   map of `group path` -> group config
 * @param {string[]} groupPath
 * @returns {{ key: string, config: object }}
 */
export function matchGroup(groups, groupPath) {
  const groupString = groupPath.join('.');
  let best = { key: '', config: {} };
  for (const [key, config] of Object.entries(groups)) {
    if (groupString === key || groupString.startsWith(`${key}.`)) {
      if (key.split('.').length >= best.key.split('.').length && key !== '') {
        best = { key, config };
      }
    }
  }
  return best;
}

/**
 * Sort helper: numbers first, then a stable alphabetical tail. Used for
 * palettes so that step 0, 10, 20 ... 100 read in scale order regardless of
 * the order they happen to appear in the token file.
 *
 * @param {{ step: number|null, name: string }} a
 * @param {{ step: number|null, name: string }} b
 * @returns {number}
 */
export function compareByStep(a, b) {
  if (a.step !== null && b.step !== null) return a.step - b.step || a.name.localeCompare(b.name);
  if (a.step !== null) return -1;
  if (b.step !== null) return 1;
  return 0;
}
