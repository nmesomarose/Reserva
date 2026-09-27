/**
 * args.mjs
 * ---------------------------------------------------------------------------
 * A small declarative CLI parser. No dependencies, predictable errors, and a
 * help text that is generated from the same specification that does the
 * parsing, so the two can never disagree.
 *
 * Supported forms
 *   --name value        long option with a value
 *   --name=value        same, for people who prefer it
 *   -n value            short alias
 *   --flag              boolean, true when present
 *   --no-flag           boolean, false when present
 *   positional          first non option wins as `input`
 */

/** Every option the CLI accepts, with its type and default. */
export const OPTION_SPEC = {
  input: { type: 'string', short: 'i', default: 'design-tokens.tokens.json', help: 'Token file to read.' },
  out: { type: 'string', short: 'o', default: 'dist', help: 'Directory for generated files.' },
  config: { type: 'string', default: 'tokens.build.config.json', help: 'Build config file; ignored if missing.' },
  prefix: { type: 'string', default: '--ds-', help: 'Prefix for every custom property.' },
  unit: { type: 'enum', values: ['px', 'rem'], default: 'px', help: 'Unit for dimension tokens.' },
  'root-size': { type: 'number', default: 16, help: 'Root font size used when --unit=rem.' },
  'color-format': {
    type: 'enum',
    values: ['modern', 'hex', 'native'],
    default: 'modern',
    help: 'modern = rgb(r g b / a), hex = #rrggbb[aa], native = pass the token value through.',
  },
  'role-values': {
    type: 'enum',
    values: ['alias', 'literal'],
    default: 'alias',
    help: 'Emit roles as var() references to primitives (alias) or as resolved colours (literal).',
  },
  'font-stack': { type: 'string', default: '', help: 'Fallback stack appended to every font family, e.g. "system-ui, sans-serif".' },
  channels: { type: 'boolean', default: true, help: 'Emit a -rgb companion variable for every colour.' },
  'alpha-vars': { type: 'boolean', default: false, help: 'Also emit a -alpha companion for translucent colours.' },
  'font-shorthand': { type: 'boolean', default: true, help: 'Emit a font shorthand variable per text style.' },
  sort: { type: 'enum', values: ['palette', 'file'], default: 'palette', help: 'Sort palette steps numerically or keep file order.' },
  indent: { type: 'string', default: '  ', help: 'Indentation used inside :root blocks.' },
  check: { type: 'boolean', default: false, help: 'Do not write. Exit 1 if the generated files differ from disk.' },
  stdout: { type: 'boolean', default: false, help: 'Print the stylesheet instead of writing files.' },
  strict: { type: 'boolean', default: false, help: 'Exit 1 when any warning is produced.' },
  quiet: { type: 'boolean', short: 'q', default: false, help: 'Only print errors and the final one line summary.' },
  verbose: { type: 'boolean', short: 'v', default: false, help: 'Print every generated file path and full findings.' },
  help: { type: 'boolean', short: 'h', default: false, help: 'Show this help.' },
  version: { type: 'boolean', default: false, help: 'Show the tool version.' },
};

const LONG_TO_KEY = new Map();
const SHORT_TO_KEY = new Map();
for (const [key, spec] of Object.entries(OPTION_SPEC)) {
  LONG_TO_KEY.set(key, key);
  if (spec.short) SHORT_TO_KEY.set(spec.short, key);
}

/**
 * @param {string[]} argv arguments after `node script.mjs`
 * @returns {{ options: object, positional: string[], errors: string[] }}
 */
export function parseArgs(argv) {
  const options = Object.fromEntries(
    Object.entries(OPTION_SPEC).map(([key, spec]) => [
      key,
      spec.type === 'boolean' ? spec.default : spec.default,
    ]),
  );
  const seen = new Set();
  const positional = [];
  const errors = [];

  const setValue = (key, raw) => {
    const spec = OPTION_SPEC[key];
    seen.add(key);
    if (spec.type === 'boolean') {
      options[key] = raw !== 'false' && raw !== '0';
      return;
    }
    if (spec.type === 'number') {
      const value = Number(raw);
      if (Number.isNaN(value)) {
        errors.push(`--${key} expects a number, received "${raw}".`);
        return;
      }
      options[key] = value;
      return;
    }
    if (spec.type === 'enum') {
      if (!spec.values.includes(raw)) {
        errors.push(`--${key} expects one of ${spec.values.join(', ')}, received "${raw}".`);
        return;
      }
      options[key] = raw;
      return;
    }
    options[key] = raw;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const [rawName, inlineValue] = body.includes('=') ? [body.slice(0, body.indexOf('=')), body.slice(body.indexOf('=') + 1)] : [body, null];

      if (rawName.startsWith('no-')) {
        const key = LONG_TO_KEY.get(rawName.slice(3));
        if (key && OPTION_SPEC[key].type === 'boolean') {
          seen.add(key);
          options[key] = false;
          continue;
        }
      }

      const key = LONG_TO_KEY.get(rawName);
      if (!key) {
        errors.push(`Unknown option "--${rawName}". Run with --help to see the list.`);
        continue;
      }
      const spec = OPTION_SPEC[key];
      if (spec.type === 'boolean') {
        setValue(key, inlineValue ?? 'true');
        continue;
      }
      const value = inlineValue ?? argv[++index];
      if (value === undefined) {
        errors.push(`--${rawName} expects a value.`);
        continue;
      }
      setValue(key, value);
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const key = SHORT_TO_KEY.get(token.slice(1));
      if (!key) {
        errors.push(`Unknown option "${token}". Run with --help to see the list.`);
        continue;
      }
      const spec = OPTION_SPEC[key];
      if (spec.type === 'boolean') {
        setValue(key, 'true');
        continue;
      }
      const value = argv[++index];
      if (value === undefined) {
        errors.push(`${token} expects a value.`);
        continue;
      }
      setValue(key, value);
      continue;
    }

    positional.push(token);
  }

  if (positional.length > 0) options.input = positional[0];
  if (positional.length > 1) errors.push(`Unexpected extra arguments: ${positional.slice(1).join(' ')}`);

  return { options, positional, errors, seen };
}

/** Render `--help` from the spec so documentation cannot drift. */
export function helpText(version) {
  const lines = [];
  lines.push(`design-tokens-to-css ${version}`);
  lines.push('');
  lines.push('Convert a Figma/W3C design token export into CSS custom properties,');
  lines.push('a JSON token report, a Markdown reference and an HTML style guide.');
  lines.push('');
  lines.push('USAGE');
  lines.push('  node scripts/build-tokens.mjs [input.tokens.json] [options]');
  lines.push('');
  lines.push('OUTPUT');
  lines.push('  <out>/tokens.css            custom properties, ready to import');
  lines.push('  <out>/tokens.report.json     machine readable token report');
  lines.push('  <out>/TOKENS.md             human readable reference');
  lines.push('  <out>/tokens.preview.html   self-contained visual style guide');
  lines.push('');
  lines.push('OPTIONS');

  const rows = Object.entries(OPTION_SPEC).map(([key, spec]) => {
    const short = spec.short ? `-${spec.short}, ` : '    ';
    const value = spec.type === 'boolean' ? '' : ` <${spec.type === 'enum' ? spec.values.join('|') : spec.type}>`;
    const defaultText =
      spec.type === 'boolean'
        ? spec.default
          ? 'default: on'
          : 'default: off'
        : `default: ${JSON.stringify(spec.default)}`;
    return [`  ${short}--${key}${value}`, spec.help, defaultText];
  });

  const width = Math.max(...rows.map(([left]) => left.length));
  for (const [left, help, defaultText] of rows) {
    lines.push(`${left.padEnd(width + 2)}${help}`);
    lines.push(`${' '.repeat(width + 2)}${defaultText}`);
  }

  lines.push('');
  lines.push('  Boolean options accept --no-<name> to turn them off, e.g. --no-channels.');
  lines.push('');
  lines.push('EXAMPLES');
  lines.push('  node scripts/build-tokens.mjs                     build everything into dist/');
  lines.push('  node scripts/build-tokens.mjs --check             fail if dist/ is stale (CI)');
  lines.push('  node scripts/build-tokens.mjs --stdout            print the stylesheet');
  lines.push('  node scripts/build-tokens.mjs --color-format hex  emit #rrggbb instead of rgb()');
  lines.push('  node scripts/build-tokens.mjs --unit rem          emit rem for spacing and type');
  lines.push('  node scripts/build-tokens.mjs --no-channels       skip the -rgb companion variables');
  lines.push('  node scripts/build-tokens.mjs --role-values literal  inline colours, no var() chain');
  return lines.join('\n');
}
