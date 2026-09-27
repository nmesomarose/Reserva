/**
 * emit-report.mjs
 * ---------------------------------------------------------------------------
 * Renders `dist/tokens.report.json`: a machine readable description of the
 * whole design system.
 *
 * This exists so that other tools never have to re-parse the Figma export. A
 * documentation site, a Storybook addon, a contrast auditor or a Figma sync
 * script can all read this one file and get, for every CSS variable: the token
 * it came from, its Figma variable id, its resolved value, and the primitive a
 * colour role is ultimately built on.
 *
 * Shape
 * -----
 *   meta        generator, source, options
 *   stats       counts
 *   roles       semantic layer, with the primitive each role points at
 *   primitives  foundation layer, with the roles that consume each colour
 *   spacing / typography / shadows
 *   contrast    measured WCAG ratios per role pair
 *   variables   flat list, one entry per CSS custom property
 *   warnings    findings, most severe first
 */

const LEVEL_RANK = { error: 0, warn: 1, info: 2 };

/**
 * @param {object} build
 * @param {object} options
 * @param {string} options.source
 * @returns {string} pretty printed JSON
 */
export function emitReport(build, { source }) {
  const report = {
    meta: {
      generator: 'scripts/build-tokens.mjs',
      source,
      schema: 1,
      options: {
        prefix: build.config.prefix,
        colorFormat: build.config.colorFormat,
        roleValues: build.config.roleValues,
        unit: build.config.unit,
        rootSize: build.config.rootSize,
        channels: build.config.channels,
        alphaVars: build.config.alphaVars,
        fontShorthand: build.config.fontShorthand,
        sort: build.config.sort,
      },
    },
    stats: build.stats,
    roles: build.roles.filter((role) => !role.derived).map(slimRole),
    primitives: build.primitives.filter((entry) => !entry.derived).map(slimPrimitive),
    palettes: build.palettes,
    spacing: build.spacing.filter((entry) => !entry.derived).map(slimScalar),
    typography: build.typography.map((style) => ({
      name: style.name,
      tokenPath: style.tokenPath,
      variables: style.variables.map((variable) => ({
        variable: variable.name,
        cssProperty: variable.cssProperty,
        value: variable.value,
      })),
    })),
    shadows: build.shadows.map(slimShadow),
    contrast: build.pairs,
    variables: build.variables.map(slimVariable),
    warnings: [...build.warnings]
      .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || String(a.token).localeCompare(String(b.token)))
      .map((warning) => ({ level: warning.level, code: warning.code, token: warning.token, message: warning.message })),
  };

  return `${JSON.stringify(report, null, 2)}\n`;
}

/* ------------------------------------------------------------------ helpers */

function slimRole(role) {
  return {
    role: role.tokenName,
    variable: role.name,
    value: role.value,
    hex: role.colorHex,
    isAlias: role.isAlias,
    primitive: role.primitiveName,
    primitiveVariable: role.aliasTarget,
    figmaVariableId: role.figma?.variableId ?? null,
    description: role.description,
  };
}

function slimPrimitive(entry) {
  return {
    token: entry.tokenName,
    variable: entry.name,
    value: entry.value,
    hex: entry.colorHex,
    palette: entry.groupTitle,
    rgbChannels: entry.color ? `${entry.color.r} ${entry.color.g} ${entry.color.b}` : null,
    figmaVariableId: entry.figma?.variableId ?? null,
  };
}

function slimScalar(entry) {
  return {
    token: entry.tokenName,
    variable: entry.name,
    value: entry.value,
    figmaVariableId: entry.figma?.variableId ?? null,
  };
}

function slimShadow(entry) {
  return {
    token: entry.tokenName,
    variable: entry.name,
    boxShadow: entry.value,
    figmaStyleId: entry.figma?.styleId ?? null,
  };
}

function slimVariable(entry) {
  return {
    variable: entry.name,
    value: entry.value,
    section: entry.section,
    category: entry.section === 'roles' ? 'semantic-role' : entry.section === 'primitives' ? 'primitive' : entry.section,
    sourceToken: entry.tokenPath,
    sourceType: entry.type,
    description: entry.description,
    cssProperty: entry.cssProperty ?? null,
    derived: entry.derived,
    figmaVariableId: entry.figma?.variableId ?? null,
    figmaStyleId: entry.figma?.styleId ?? null,
  };
}
