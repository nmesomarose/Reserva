/**
 * emit-css.mjs
 * ---------------------------------------------------------------------------
 * Renders the build as a single, heavily commented stylesheet.
 *
 * Two properties are deliberate and load bearing:
 *
 * 1. Deterministic output. No timestamps, no absolute paths, no random order.
 *    Running the build twice on the same input produces byte identical files,
 *    which is what makes `npm run check` usable as a CI guard.
 *
 * 2. The two tier colour model is visible in the file itself. Semantic roles
 *    come first with an explicit "apply these" banner, primitives follow with
 *    an explicit "do not apply these" banner, and every declaration carries a
 *    comment naming the Figma token it came from. Anyone opening this file in
 *    a code review can see which tier a value belongs to without consulting
 *    the docs.
 */

const RULE = '='.repeat(78);
const THIN = '-'.repeat(78);

/**
 * @param {object} build result of buildTokens()
 * @param {object} options
 * @param {string} options.source  token file name, used in the header comment
 * @param {string} [options.indent='  ']
 * @returns {string} stylesheet
 */
export function emitCss(build, { source, indent = '  ' }) {
  const out = [];

  out.push(header({ build, source }));
  out.push('');

  for (const section of build.sections) {
    if (section.entries.length === 0) continue;
    out.push(sectionBanner(section));
    out.push(':root {');
    for (const entry of section.entries) {
      for (const line of commentFor(entry)) out.push(`${indent}/* ${line} */`);
      out.push(`${indent}${entry.name}: ${entry.value};`);
      out.push('');
    }
    // Trim the trailing blank line inside the block.
    if (out[out.length - 1] === '') out.pop();
    out.push('}');
    out.push('');
  }

  out.push(footer({ build, source }));
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/* ------------------------------------------------------------------ pieces */

function header({ build, source }) {
  const { config, stats } = build;
  return `/**
 * Design tokens -> CSS custom properties
 * ----------------------------------------------------------------------
 * GENERATED FILE - DO NOT EDIT. Regenerate with:  npm run build
 *
 * Source     ${source}
 * Prefix     ${config.prefix}
 * Colours    ${config.colorFormat}   |  units ${config.unit}${config.unit === 'rem' ? ` (root ${config.rootSize}px)` : ''}
 * Roles emit ${config.roleValues === 'alias' ? 'var() references to primitives' : 'literal resolved colours'}
 *
 * ${stats.variables} custom properties from ${stats.tokens} tokens
 *   ${stats.roles} colour roles          ${stats.primitives} primitive colours
 *   ${stats.spacing} spacing steps       ${stats.typographyStyles} text styles (${stats.typographyVariables} variables)
 *   ${stats.shadows} shadows             ${stats.pairs} contrast pairs checked
 *
 * The two tiers of the colour model
 * ----------------------------------------------------------------------
 *   --ds-color-*                     semantic ROLES.  Apply these in the UI.
 *   --ds-color-primitive-*           primitive FOUNDATIONS.  Never in the UI.
 *
 * A role points at a primitive, so re-pointing a primitive re-themes the whole
 * product. Components must only ever read the roles.
 *
 * This file is deterministic: no timestamps, no machine paths. Regenerating
 * from an unchanged source produces an identical file.
 */`;
}

function sectionBanner(section) {
  const lines = [`/* ${RULE}`, ` * ${section.title.toUpperCase()}`, ` * ${THIN}`];
  for (const line of section.banner) lines.push(` * ${line}`);
  if (section.usage) lines.push(' *', ` * >> ${section.usage}`);
  lines.push(` * ${RULE}`, ' */');
  return lines.join('\n');
}

function commentFor(entry) {
  const lines = [];
  const figma = entry.figma?.variableId ? ` ${entry.figma.variableId}` : entry.figma?.styleId ? ` ${entry.figma.styleId}` : '';

  if (entry.section === 'roles' && entry.alias) {
    lines.push(`Role: ${entry.tokenName}`);
    lines.push(`Figma: ${entry.tokenPath}${figma}`);
    if (entry.colorHex) lines.push(`Value: ${entry.colorHex}  via ${entry.alias}`);
  } else if (entry.derived === 'channels') {
    lines.push(`Channels of ${entry.name.replace(/-rgb$/, '')} - for rgb(var(${entry.name}) / 50%)`);
  } else {
    lines.push(`Figma: ${entry.tokenPath}${figma}`);
    if (entry.derived === 'alpha') lines.push('Alpha channel, 0-1');
  }

  if (entry.cssProperty) lines.push(`CSS property: ${entry.cssProperty}`);
  return lines;
}

function footer({ build, source }) {
  return `/* ${RULE}
 * End of generated tokens.
 *
 * Regenerate : npm run build
 * Verify      : npm run check          (fails if ${source} has changed)
 * Preview     : open dist/tokens.preview.html
 * Reference   : dist/TOKENS.md
 * ------------------------------------------------------------------------ */`;
}
