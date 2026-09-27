/**
 * colour.mjs
 * ---------------------------------------------------------------------------
 * Colour parsing, canonical formatting and WCAG maths.
 *
 * The token source (a Figma Variables export) stores colours as 8-digit hex
 * strings such as `#2215d6ff`. Every colour in the pipeline is parsed once
 * into a `{ r, g, b, a }` record with 0-255 channels and a 0-1 alpha, which
 * makes every downstream operation (formatting, contrast checks, preview
 * swatches) independent of the original notation.
 *
 * No dependencies: everything here is plain arithmetic.
 */

/** @typedef {{ r: number, g: number, b: number, a: number }} Rgba */

/** Matches `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa` (case insensitive). */
const HEX_RE = /^#([\da-f]{3,8})$/i;

/** Matches the legacy comma separated `rgb()` / `rgba()` notations. */
const RGB_FUNC_RE = /^rgba?\(\s*([^)]+)\)$/i;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Parse a colour string into an RGBA record.
 *
 * @param {string} input e.g. `#2215d6ff`, `#fff`, `rgba(0,0,0,.32)`
 * @returns {Rgba|null} `null` when the notation is not understood
 */
export function parseColor(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim();

  const hex = HEX_RE.exec(value);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      const [r, g, b, a] = digits.split('').map((char) => parseInt(char + char, 16));
      return { r, g, b, a: digits.length === 4 ? a / 255 : 1 };
    }
    if (digits.length === 6 || digits.length === 8) {
      const pairs = digits.match(/[\da-f]{2}/gi).map((pair) => parseInt(pair, 16));
      return { r: pairs[0], g: pairs[1], b: pairs[2], a: pairs[3] === undefined ? 1 : pairs[3] / 255 };
    }
    return null;
  }

  const fn = RGB_FUNC_RE.exec(value);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (raw) =>
      raw.endsWith('%')
        ? Math.round((parseFloat(raw) / 100) * 255)
        : Math.round(parseFloat(raw));
    const [r, g, b] = parts.slice(0, 3).map(channel);
    const alphaRaw = parts[3];
    const a = alphaRaw === undefined
      ? 1
      : alphaRaw.endsWith('%')
        ? parseFloat(alphaRaw) / 100
        : parseFloat(alphaRaw);
    if ([r, g, b].some(Number.isNaN)) return null;
    return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: Number.isNaN(a) ? 1 : clamp(a, 0, 1) };
  }

  return null;
}

/** True when the value looks like a colour the formatter can handle. */
export function isColor(value) {
  return parseColor(value) !== null;
}

const hex2 = (channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, '0');

/** Drop meaningless floating point noise (`1` instead of `1.0000`). */
const tidy = (number) => Number.parseFloat(Number(number).toFixed(4));

/**
 * Canonical hex notation. Alpha is only written when the colour is translucent,
 * which keeps `rgb`-like noise out of the generated CSS.
 *
 * @param {Rgba} color
 * @returns {string} e.g. `#2215d6` or `#00000080`
 */
export function toHex(color) {
  const base = `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`;
  return color.a >= 1 ? base : `${base}${hex2(color.a * 255)}`;
}

/**
 * Modern CSS colour function: `rgb(r g b)` / `rgb(r g b / a)`.
 * Space separated + slash alpha works in every browser since 2020 and keeps
 * alpha readable, e.g. `rgb(0 0 0 / 0.3216)`.
 *
 * @param {Rgba} color
 * @returns {string}
 */
export function toRgbString(color) {
  const channels = `${Math.round(color.r)} ${Math.round(color.g)} ${Math.round(color.b)}`;
  return color.a >= 1 ? `rgb(${channels})` : `rgb(${channels} / ${tidy(color.a)})`;
}

/**
 * Space separated channels for `rgb(var(--x) / 50%)` style composition.
 *
 * @param {Rgba} color
 * @returns {string} e.g. `80 69 237`
 */
export function toChannels(color) {
  return `${Math.round(color.r)} ${Math.round(color.g)} ${Math.round(color.b)}`;
}

/** Pick a readable foreground for a swatch in the HTML preview. */
export function readableTextOn(color) {
  return relativeLuminance(color) > 0.4 ? '#101014' : '#ffffff';
}

/** sRGB channel linearisation required by WCAG 2.1. */
function linearize(channel8bit) {
  const c = channel8bit / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * WCAG relative luminance.
 *
 * @param {Rgba} color
 * @returns {number} 0 (black) .. 1 (white)
 */
export function relativeLuminance(color) {
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

/**
 * WCAG 2.1 contrast ratio between two colours (1:1 .. 21:1).
 *
 * @param {Rgba} foreground
 * @param {Rgba} background
 * @returns {number}
 */
export function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

/** WCAG conformance verdicts, used by the validator and the docs. */
export const CONTRAST_LEVELS = {
  AA_TEXT: 4.5,
  AA_LARGE_TEXT: 3,
  AA_NON_TEXT: 3,
  AAA_TEXT: 7,
};
