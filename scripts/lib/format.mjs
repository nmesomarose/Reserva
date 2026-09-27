/**
 * format.mjs
 * ---------------------------------------------------------------------------
 * Converts resolved token values into CSS value strings.
 *
 * Two conversion decisions worth knowing about:
 *
 * 1. Dimensions get an explicit unit (`64` -> `64px`). The Figma export stores
 *    bare numbers and treats everything as px. Pass `unit: 'rem'` to emit
 *    `rem` instead (divided by `rootSize`), which makes spacing and typography
 *    scale with the user's browser font size.
 *
 * 2. Composites are expanded, not collapsed. A typography style becomes one
 *    variable per CSS property rather than a single opaque blob, so a heading
 *    can borrow `--ds-typography-headline-large-line-height` without adopting
 *    the whole style. A convenience `font` shorthand is emitted too.
 */

import { parseColor, toHex, toRgbString } from './color.mjs';

/**
 * Typographic sub-property -> CSS property.
 * `textCase` and `paragraphSpacing` have no exact CSS equivalent; the chosen
 * mapping is documented in the generated Markdown reference and validated by
 * a round trip check in the tests.
 */
export const TYPOGRAPHY_PROPERTIES = {
  fontFamily: { property: 'font-family', format: 'font-family' },
  fontSize: { property: 'font-size', format: 'dimension' },
  fontWeight: { property: 'font-weight', format: 'raw' },
  fontStyle: { property: 'font-style', format: 'raw' },
  fontStretch: { property: 'font-stretch', format: 'raw' },
  letterSpacing: { property: 'letter-spacing', format: 'dimension' },
  lineHeight: { property: 'line-height', format: 'dimension' },
  textDecoration: { property: 'text-decoration', format: 'raw' },
  textCase: { property: 'text-transform', format: 'text-transform' },
  paragraphIndent: { property: 'text-indent', format: 'dimension' },
  paragraphSpacing: { property: 'margin', format: 'dimension' },
};

/** Emit order for typography variables (most fundamental first). */
export const TYPOGRAPHY_ORDER = [
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
];

/** Figma text case -> CSS text-transform. */
const TEXT_CASE_MAP = {
  none: 'none',
  uppercase: 'uppercase',
  lower: 'lowercase',
  lowercase: 'lowercase',
  capitalize: 'capitalize',
  'small caps': 'small-caps',
  smallcaps: 'small-caps',
};

/**
 * Create the formatter bound to one set of build options.
 *
 * @param {object} options
 * @param {'px'|'rem'} [options.unit='px']
 * @param {number} [options.rootSize=16] root font size used for rem conversion
 * @param {'modern'|'hex'|'native'} [options.colorFormat='modern']
 * @param {string} [options.fontStack=''] optional fallback stack appended to font families
 * @returns {object} formatter
 */
export function createFormatter(options = {}) {
  const unit = options.unit ?? 'px';
  const rootSize = options.rootSize ?? 16;
  const colorFormat = options.colorFormat ?? 'modern';
  const fontStack = (options.fontStack ?? '').trim();

  /** @param {number} value @returns {string} */
  const dimension = (value) => {
    if (typeof value !== 'number' || Number.isNaN(value)) return String(value);
    if (unit === 'rem') {
      const rem = Number.parseFloat((value / rootSize).toFixed(4));
      return `${rem}rem`;
    }
    return `${value}px`;
  };

  const color = (value, { native = null } = {}) => {
    if (colorFormat === 'native') return native ?? String(value);
    const rgba = parseColor(value);
    if (!rgba) return native ?? String(value);
    return colorFormat === 'hex' ? toHex(rgba) : toRgbString(rgba);
  };

  const fontFamily = (value) => {
    const family = `"${String(value).replace(/"/g, '')}"`;
    return fontStack ? `${family}, ${fontStack}` : family;
  };

  const textTransform = (value) => TEXT_CASE_MAP[String(value).trim().toLowerCase()] ?? String(value);

  return {
    dimension,
    color,
    fontFamily,
    textTransform,
    /** @param {string|number|boolean} value */
    raw: (value) => String(value),

    /**
     * Format one property of a typography composite.
     *
     * @param {string} key source property name, e.g. `fontSize`
     * @param {unknown} value
     * @returns {{ property: string, value: string }|null}
     */
    typographyProperty(key, value) {
      const spec = TYPOGRAPHY_PROPERTIES[key];
      if (!spec) return null;
      const formatted = formatByKind(spec.format, value);
      if (formatted === null) return null;
      return { property: spec.property, value: formatted };
    },

    /**
     * Build the CSS `font` shorthand for a typography composite.
     * Only emitted when family, size, weight and line height are all present,
     * because `font` resets properties it omits.
     *
     * @param {object} parts `{ fontFamily, fontSize, fontWeight, lineHeight, fontStyle }` in px numbers
     * @returns {string|null}
     */
    fontShorthand(parts) {
      const { fontFamily: family, fontSize, fontWeight, lineHeight, fontStyle } = parts;
      if (family === undefined || fontSize === undefined) return null;
      const style = fontStyle && fontStyle !== 'normal' ? `${fontStyle} ` : '';
      const weight = typeof fontWeight === 'number' ? `${fontWeight} ` : '';
      const line = typeof lineHeight === 'number' ? `${dimension(lineHeight)}` : 'normal';
      return `${style}${weight}${dimension(fontSize)}/${line} ${fontFamily(family)}`;
    },

    /**
     * Convert a `custom-shadow` value object into a `box-shadow` value.
     * Figma calls the CSS blur radius "radius" and CSS spread "spread";
     * `inset` shadows are prefixed with `inset`.
     *
     * @param {object|string} value
     * @returns {{ value: string, layers: object[] }|null}
     */
    shadow(value) {
      const layers = Array.isArray(value) ? value : [value];
      const rendered = [];
      for (const layer of layers) {
        if (layer === null || typeof layer !== 'object') continue;
        const type = String(layer.shadowType ?? 'dropShadow').toLowerCase();
        const x = numberOr(layer.offsetX, 0);
        const y = numberOr(layer.offsetY, 0);
        const blur = numberOr(layer.radius, 0);
        const spread = numberOr(layer.spread, 0);
        const parts = [
          dimension(x),
          dimension(y),
          dimension(blur),
          spread === 0 ? null : dimension(spread),
          color(layer.color),
        ].filter((part) => part !== null);
        const prefix = type === 'innershadow' || type === 'inner shadow' ? 'inset ' : '';
        rendered.push(`${prefix}${parts.join(' ')}`);
      }
      if (rendered.length === 0) return null;
      return { value: rendered.join(', '), layers: rendered };
    },
  };

  function formatByKind(kind, value) {
    switch (kind) {
      case 'dimension':
        return typeof value === 'number' ? dimension(value) : String(value);
      case 'font-family':
        return fontFamily(value);
      case 'text-transform':
        return textTransform(value);
      default:
        return value === null || value === undefined ? null : String(value);
    }
  }
}

const numberOr = (value, fallback) => (typeof value === 'number' && !Number.isNaN(value) ? value : fallback);
