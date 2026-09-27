/**
 * parse.mjs
 * ---------------------------------------------------------------------------
 * Reads the Figma/W3C token document into a flat list of tokens and resolves
 * the alias graph (`{primitive colour collection.key colour group.primary
 * key colour}`).
 *
 * Compatibility notes
 * -------------------
 * The document is a Figma Variables export that still uses the pre-final DTCG
 * keys (`value` / `type` / `description`). The DTCG `$value` / `$type` /
 * `$description` spellings are accepted as well, so the same script keeps
 * working after the file is re-exported with the current specification.
 *
 * Token kinds produced
 * --------------------
 * scalar      a leaf with a primitive value (color, dimension, number, string-)
 * reference   a leaf whose value is `{path.to.other.token}` (an alias)
 * composite   a leaf with an object value: typography, custom-shadow, border-
 * style group a group whose children are all typographic properties
 *             (`typography / body large / fontSize / value`). Figma exports
 *             text styles without a `type`, so these are detected by shape.
 */

/** Token sub-properties that identify a typography style group. */
export const TYPOGRAPHY_KEYS = new Set([
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontStretch',
  'letterSpacing',
  'lineHeight',
  'textDecoration',
  'textCase',
  'paragraphIndent',
  'paragraphSpacing',
]);

/** DTCG types whose value is an object and therefore expanded into variables. */
const COMPOSITE_TYPES = new Set([
  'typography',
  'shadow',
  'boxShadow',
  'custom-shadow',
  'border',
  'gradient',
  'strokeStyle',
  'transition',
]);

/** Keys that are metadata rather than children, at any level of the tree. */
const RESERVED_KEYS = new Set([
  'description',
  '$description',
  'type',
  '$type',
  'value',
  '$value',
  'extensions',
  '$extensions',
  'blendMode',
  'scopes',
]);

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readValue = (node) => ('value' in node ? node.value : node.$value);
const readType = (node) => ('type' in node ? node.type : node.$type);
const readDescription = (node) => {
  if (typeof node.description === 'string') return node.description.trim() || null;
  if (typeof node.$description === 'string') return node.$description.trim() || null;
  return null;
};

/** Is this node a token (as opposed to a group of tokens)? */
export function isTokenNode(node) {
  return isPlainObject(node) && ('value' in node || '$value' in node);
}

/**
 * Figma bookkeeping copied out of `extensions` so the generated files can
 * trace a variable back to the Figma variable/style that produced it.
 *
 * Always returns an object: `blendMode` sits on the token itself rather than
 * inside the extension, and a hand written token has no extensions at all.
 */
export function readFigmaMeta(node) {
  const extensions = isPlainObject(node) ? (node.extensions ?? node.$extensions) : null;
  const meta = isPlainObject(extensions) ? extensions['org.lukasoppermann.figmaDesignTokens'] : null;
  return {
    variableId: meta?.variableId ?? null,
    styleId: meta?.styleId ?? null,
    collection: meta?.collection ?? null,
    exportKey: meta?.exportKey ?? null,
    scopes: Array.isArray(meta?.scopes) ? meta.scopes.join(', ') : null,
    blendMode: isPlainObject(node) && typeof node.blendMode === 'string' ? node.blendMode : null,
  };
}

/**
 * Heuristic detection of a Figma text style.
 * A group qualifies when it has at least three children, all of them token
 * nodes, all of them known typographic properties, and a font size is present.
 *
 * @param {object} node
 * @returns {boolean}
 */
export function isTypographyStyleNode(node) {
  const entries = Object.entries(node).filter(([key]) => !RESERVED_KEYS.has(key));
  if (entries.length < 3) return false;
  if (!entries.some(([key]) => key === 'fontSize')) return false;
  return entries.every(([key, child]) => TYPOGRAPHY_KEYS.has(key) && isTokenNode(child));
}

function makeToken({ name, path, node, type, kind }) {
  return {
    name,
    path,
    pathString: path.join('.'),
    groupPath: path.slice(0, -1),
    type: type ?? null,
    value: isTokenNode(node) ? readValue(node) : null,
    description: readDescription(node),
    figma: readFigmaMeta(node),
    kind,
  };
}

/**
 * Normalise the children of a composite token.
 *
 * Two shapes occur in practice:
 *  - Figma text styles: `{ fontSize: { type, value }, fontFamily: { type, value } }`
 *  - DTCG composites:  `{ "fontSize": { "value": 64, "unit": "px" } }` or plain `{ "fontSize": 64 }`
 *
 * Both are reduced to `{ key, type, value }` so downstream code has a single
 * shape to deal with.
 *
 * @param {object} value
 * @returns {[string, { name: string, type: string|null, value: unknown, figma: object|null }][]}
 */
function compositeEntries(value) {
  return Object.entries(value ?? {})
    .filter(([key]) => !RESERVED_KEYS.has(key))
    .map(([key, sub]) => [
      key,
      isPlainObject(sub) && ('value' in sub || '$value' in sub)
        ? { name: key, type: readType(sub) ?? null, value: readValue(sub), figma: readFigmaMeta(sub) }
        : { name: key, type: null, value: sub, figma: null },
    ]);
}

/**
 * Walk the token document and produce a flat, ordered list of tokens.
 *
 * @param {object} root parsed token JSON
 * @returns {{ tokens: object[], groups: string[][], byPath: Map<string, object> }}
 */
export function flattenTokens(root) {
  if (!isPlainObject(root)) {
    throw new TypeError('Token document must be a JSON object.');
  }

  /** @type {object[]} */
  const tokens = [];
  /** @type {string[][]} */
  const groups = [];

  const walk = (node, path, inheritedType) => {
    for (const [name, child] of Object.entries(node)) {
      if (RESERVED_KEYS.has(name)) continue;
      if (!isPlainObject(child)) continue;

      const childPath = [...path, name];
      const type = readType(child) ?? inheritedType ?? null;

      if (isTokenNode(child) && isPlainObject(readValue(child))) {
        // Composite token: typography, custom-shadow, border, gradient-
        tokens.push(makeToken({ name, path: childPath, node: child, type: type ?? 'composite', kind: 'composite' }));
        continue;
      }

      if (isTokenNode(child)) {
        const value = readValue(child);
        const kind = typeof value === 'string' && isReference(value) ? 'reference' : 'scalar';
        tokens.push(makeToken({ name, path: childPath, node: child, type, kind }));
        continue;
      }

      if (isTypographyStyleNode(child)) {
        const style = makeToken({ name, path: childPath, node: {}, type: 'typography', kind: 'style-group' });
        style.value = Object.fromEntries(compositeEntries(child));
        tokens.push(style);
        continue;
      }

      groups.push(childPath);
      walk(child, childPath, type);
    }
  };

  walk(root, [], null);

  const byPath = new Map(tokens.map((token) => [token.pathString, token]));
  return { tokens, groups, byPath };
}

/** `{some.token.path}` */
export function isReference(value) {
  return typeof value === 'string' && /^\{[^}]+\}$/.test(value.trim());
}

/** `{some.token.path}` -> `['some','token','path']` */
export function referenceToPath(value) {
  return value
    .trim()
    .replace(/^\{|\}$/g, '')
    .replace(/^\.\//, '')
    .split('.')
    .filter(Boolean);
}

/**
 * Resolve every token to a concrete value.
 *
 * - scalar tokens keep their authored value
 * - reference tokens are followed to their target (chains are supported)
 * - composite tokens resolve each of their sub-values
 *
 * Cycles are reported instead of hanging, and `dangling` is recorded so the
 * validator can turn it into a visible warning.
 *
 * @param {object[]} tokens
 * @returns {{ resolved: Map<string, object>, issues: object[] }}
 */
export function resolveTokens(tokens) {
  const byPath = new Map(tokens.map((token) => [token.pathString, token]));
  const cache = new Map();
  const issues = [];

  const resolveOne = (token, stack) => {
    if (cache.has(token.pathString)) return cache.get(token.pathString);

    if (stack.includes(token.pathString)) {
      issues.push({
        code: 'reference-cycle',
        level: 'error',
        token: token.pathString,
        message: `Circular reference: ${[...stack, token.pathString].join(' -> ')}`,
      });
      const record = { value: null, reference: null, chain: [], dangling: true, cycle: true };
      cache.set(token.pathString, record);
      return record;
    }

    let record;

    if (token.kind === 'reference') {
      const targetPath = referenceToPath(token.value).join('.');
      const target = byPath.get(targetPath);
      if (!target) {
        issues.push({
          code: 'unresolved-reference',
          level: 'error',
          token: token.pathString,
          message: `Reference "${token.value}" does not resolve to a token in this document.`,
        });
        record = { value: null, reference: targetPath, chain: [], dangling: true };
      } else {
        const next = resolveOne(target, [...stack, token.pathString]);
        record = {
          value: next.value,
          reference: targetPath,
          chain: [targetPath, ...next.chain],
          dangling: next.dangling,
          cycle: next.cycle,
        };
      }
    } else if (token.kind === 'composite' || token.kind === 'style-group') {
      const subValues = {};
      const subReferences = {};
      let dangling = false;
      for (const [key, sub] of compositeEntries(token.value)) {
        const childPath = `${token.pathString}.${key}`;
        const pseudoToken = {
          pathString: childPath,
          kind: typeof sub.value === 'string' && isReference(sub.value) ? 'reference' : 'scalar',
          value: sub.value,
        };
        const resolved = resolveOne(pseudoToken, [...stack, token.pathString]);
        subValues[key] = resolved.value;
        if (resolved.reference) subReferences[key] = resolved.reference;
        if (resolved.dangling) dangling = true;
      }
      record = { value: subValues, reference: null, subReferences, chain: [], dangling };
    } else {
      record = { value: token.value, reference: null, chain: [], dangling: false };
    }

    cache.set(token.pathString, record);
    return record;
  };

  for (const token of tokens) resolveOne(token, []);

  return { resolved: cache, issues };
}
