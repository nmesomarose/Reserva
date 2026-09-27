/**
 * emit-html.mjs
 * ---------------------------------------------------------------------------
 * Renders `dist/tokens.preview.html`: a self-contained visual style guide.
 *
 * Design notes
 * ------------
 * The preview is styled entirely with the generated custom properties. If a
 * variable is wrong, the preview is visibly wrong, so the page doubles as a
 * smoke test of `tokens.css` rather than a screenshot of the JSON.
 *
 * The two colour tiers are presented differently on purpose. Roles get large
 * cards and an "apply in the UI" badge; primitives get a compact ramp with a
 * "foundations only" warning. The page should make it obvious which one a
 * developer is meant to reach for.
 *
 * No frameworks, no fonts, no network: one file, opens from disk.
 */

import { readableTextOn } from './color.mjs';

const esc = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * @param {object} build
 * @param {object} options
 * @param {string} options.source
 * @returns {string} a complete HTML document
 */
export function emitHtml(build, { source, css }) {
  const { stats } = build;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Design tokens preview</title>
<style>
/* ---------------------------------------------------------------------------
   The generated tokens, inlined verbatim. This is the artefact under test.
   --------------------------------------------------------------------------- */
${css}

/* ---------------------------------------------------------------------------
   Preview chrome only. Nothing in this block is part of the design system.
   --------------------------------------------------------------------------- */
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: var(--ds-typography-body-medium-font, system-ui, sans-serif);
  color: #1b1b1f;
  background: #fbfbfd;
  line-height: 1.5;
}
header {
  padding: 2.5rem 2rem 2rem;
  background: #12121a;
  color: #fff;
}
header h1 { margin: 0 0 .5rem; font-size: 1.75rem; letter-spacing: -.02em; }
header p { margin: .25rem 0; color: #b9b9c6; max-width: 62ch; }
header code { background: #ffffff1a; padding: .1em .4em; border-radius: 4px; }
.tiers { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1.25rem; }
.tier { border: 1px solid #ffffff26; border-radius: 8px; padding: .6rem .9rem; font-size: .85rem; }
.tier b { display: block; letter-spacing: .02em; }
main { max-width: 1180px; margin: 0 auto; padding: 0 2rem 5rem; }
section { margin: 3rem 0 0; }
h2 { font-size: 1.3rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
h3 { font-size: .95rem; margin: 2rem 0 .5rem; text-transform: uppercase; letter-spacing: .08em; color: #6b6b78; }
.lede { margin: 0 0 1.25rem; color: #55555f; max-width: 70ch; }
.badge {
  display: inline-block; font-size: .72rem; font-weight: 700; letter-spacing: .08em;
  text-transform: uppercase; padding: .3em .6em; border-radius: 4px; margin-bottom: 1rem;
}
.badge-yes { background: #d8f5e3; color: #0b6b3a; }
.badge-no  { background: #fdecec; color: #a51d1d; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: .9rem; }
.card { border: 1px solid #e4e4ec; border-radius: 10px; overflow: hidden; background: #fff; }
.swatch { height: 92px; display: flex; align-items: flex-end; padding: .5rem .65rem; box-sizing: border-box; }
.swatch span { font-size: .7rem; font-weight: 700; letter-spacing: .04em; }
.meta { padding: .6rem .7rem .75rem; }
.meta strong { display: block; font-size: .9rem; }
.var { display: block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .74rem; color: #6b6b78; word-break: break-all; cursor: pointer; }
.var:hover { color: #12121a; text-decoration: underline; }
.arrow { font-size: .74rem; color: #8a8a96; margin-top: .2rem; font-family: ui-monospace, Menlo, monospace; }
.ramp { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { width: 74px; border-radius: 6px; overflow: hidden; border: 1px solid #e4e4ec; background: #fff; }
.chip .fill { height: 52px; }
.chip .fill span { display: block; font-size: .66rem; font-weight: 700; padding: .25rem .3rem; }
.chip small { display: block; font-family: ui-monospace, Menlo, monospace; font-size: .6rem; color: #6b6b78; padding: .25rem .3rem; }
.scale { display: grid; gap: .5rem; }
.scale-row { display: grid; grid-template-columns: 190px 1fr; align-items: center; gap: .75rem; }
.scale-bar { height: 18px; background: #4a4ad6; border-radius: 4px; }
.specimens { display: grid; gap: 1.1rem; }
.spec { border: 1px solid #e4e4ec; border-radius: 10px; padding: 1rem 1.1rem; background: #fff; }
.spec .name { font-size: .72rem; letter-spacing: .08em; text-transform: uppercase; color: #6b6b78; }
.spec p { margin: .35rem 0 0; }
.shadows { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 1.2rem; }
.shadow-card { background: #fff; border: 1px solid #e4e4ec; border-radius: 10px; padding: 1.1rem; }
.shadow-demo { height: 68px; border-radius: 8px; background: #fff; border: 1px solid #eeeef4; margin-bottom: .8rem; }
table { border-collapse: collapse; width: 100%; font-size: .82rem; }
th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid #e9e9f0; }
th { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: #6b6b78; }
.pass { color: #0b6b3a; font-weight: 700; }
.fail { color: #a51d1d; font-weight: 700; }
.findings { list-style: none; padding: 0; display: grid; gap: .4rem; }
.findings li { border-left: 3px solid #c9c9d6; padding: .4rem .7rem; background: #fff; border-radius: 0 6px 6px 0; font-size: .85rem; }
.findings li.error { border-color: #c0392b; }
.findings li.warn { border-color: #d98324; }
.findings li.info { border-color: #4a4ad6; }
.findings code { font-size: .78rem; }
footer { border-top: 1px solid #e4e4ec; margin-top: 3.5rem; padding: 1.5rem 0; color: #6b6b78; font-size: .82rem; }
@media (prefers-color-scheme: dark) {
  body { background: #0e0e14; color: #e9e9f0; }
  .card, .spec, .shadow-card, .findings li { background: #17171f; border-color: #26262f; }
  th, td, .scale-row, h3, .lede { border-color: #26262f; }
  .shadow-demo { background: #17171f; border-color: #26262f; }
  h3, .lede, .var, .chip small, .arrow, footer { color: #9a9aab; }
  .chip { background: #17171f; border-color: #26262f; }
}
</style>
</head>
<body>
<header>
  <h1>Design tokens</h1>
  <p>Generated from <code>${esc(source)}</code> by <code>scripts/build-tokens.mjs</code>. Open this file directly, no server needed.</p>
  <p>${stats.variables} custom properties &middot; ${stats.roles} colour roles &middot; ${stats.primitives} primitive colours &middot; ${stats.spacing} spacing steps &middot; ${stats.typographyStyles} text styles &middot; ${stats.shadows} shadows</p>
  <div class="tiers">
    <div class="tier"><b>--ds-color-*</b>Semantic roles. Use these in components.</div>
    <div class="tier"><b>--ds-color-primitive-*</b>Foundations. Roles point at these; components do not.</div>
  </div>
</header>
<main>
${rolesSection(build)}
${primitivesSection(build)}
${contrastSection(build)}
${spacingSection(build)}
${typographySection(build)}
${shadowsSection(build)}
${findingsSection(build)}
<footer>
  Rebuild with <code>npm run build</code>. Verify the committed output with <code>npm run check</code>.<br>
  Click any variable name to copy it to the clipboard.
</footer>
</main>
<script>
document.addEventListener('click', function (event) {
  var node = event.target.closest('.var');
  if (!node) return;
  var text = node.textContent.trim();
  if (navigator.clipboard) navigator.clipboard.writeText(text);
  var previous = node.textContent;
  node.textContent = 'copied';
  setTimeout(function () { node.textContent = previous; }, 900);
});
</script>
</body>
</html>
`;
}

/* ---------------------------------------------------------------- sections */

function rolesSection(build) {
  const cards = build.roles
    .filter((role) => !role.derived)
    .map((role) => {
      const rgba = role.color;
      const ink = rgba ? readableTextOn(rgba) : '#000';
      const background = role.colorHex ?? 'transparent';
      const via = role.aliasTarget
        ? `<div class="arrow">&#8594; ${esc(role.aliasTarget)}</div>`
        : '<div class="arrow">literal value</div>';
      return `      <article class="card">
        <div class="swatch" style="background:${esc(background)};color:${ink}"><span>${esc(role.tokenName)}</span></div>
        <div class="meta">
          <strong>${esc(role.tokenName)}</strong>
          <code class="var">${esc(role.name)}</code>
          ${via}
        </div>
      </article>`;
    })
    .join('\n');

  return `  <section>
    <h2>Colour roles</h2>
    <p class="lede">The complete set of colours product code is allowed to use. Each role is a <code>var()</code> reference to a primitive, so re-pointing the primitive re-themes the product. Always reach for these.</p>
    <span class="badge badge-yes">Apply these in the UI</span>
    <div class="cards">
${cards}
    </div>
  </section>`;
}

function primitivesSection(build) {
  const blocks = build.palettes
    .map((palette) => {
      const chips = palette.steps
        .map((step) => {
          const ink = step.color ? readableTextOn(step.color) : '#000';
          return `        <div class="chip" title="${esc(step.name)}">
          <div class="fill" style="background:${esc(step.hex)};color:${ink}"><span>${esc(step.step ?? step.name)}</span></div>
          <small>${esc(step.variable)}</small>
        </div>`;
        })
        .join('\n');
      const note = palette.usedByRoles.length
        ? `${palette.usedByRoles.length} role${palette.usedByRoles.length === 1 ? '' : 's'} point here`
        : 'no role points here yet';
      return `    <h3>${esc(palette.title)} <span style="text-transform:none;letter-spacing:0;color:#8a8a96">- ${esc(note)}</span></h3>
    <div class="ramp">
${chips}
    </div>`;
    })
    .join('\n');

  return `  <section>
    <h2>Primitive colours</h2>
    <p class="lede">Raw palette steps and key colours. They exist so the roles above have a single source of truth. Referencing one of these from a component hard-codes a colour into the UI and breaks the theming contract.</p>
    <span class="badge badge-no">Foundations only - do not apply directly</span>
${blocks}
  </section>`;
}

function contrastSection(build) {
  if (build.pairs.length === 0) return '';
  const rows = build.pairs
    .map(
      (pair) => `        <tr>
          <td><code>${esc(pair.onVariable)}</code></td>
          <td><code>${esc(pair.baseVariable)}</code></td>
          <td>${pair.ratio}:1</td>
          <td class="${pair.passAA ? 'pass' : 'fail'}">${pair.passAA ? 'pass' : 'FAIL'}</td>
          <td class="${pair.passAALarge ? 'pass' : 'fail'}">${pair.passAALarge ? 'pass' : 'FAIL'}</td>
        </tr>`,
    )
    .join('\n');

  return `  <section>
    <h2>Contrast</h2>
    <p class="lede">Every <code>on&nbsp;&hellip;</code> role measured against the role it sits on, using the WCAG 2.1 relative luminance formula. This is checked on every build, so a role pointing at the wrong palette step is caught here rather than in review.</p>
    <table>
      <thead><tr><th>Foreground</th><th>Background</th><th>Ratio</th><th>AA body 4.5:1</th><th>AA large 3:1</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </section>`;
}

function spacingSection(build) {
  const rows = build.spacing
    .filter((entry) => !entry.derived)
    .map((entry) => {
      const size = parseFloat(entry.value);
      return `      <div class="scale-row">
        <code class="var">${esc(entry.name)}</code>
        <div class="scale-bar" style="width:${Math.max(2, size * 2.4)}px"></div>
      </div>`;
    })
    .join('\n');

  return `  <section>
    <h2>Spacing</h2>
    <p class="lede">A deliberately short scale. Bars are drawn at 2.4&times; the real size so the rhythm is visible at a glance.</p>
    <div class="scale">
${rows}
    </div>
  </section>`;
}

function typographySection(build) {
  const specimens = build.typography
    .map((style) => {
      const shorthand = style.variables.find((variable) => variable.cssProperty === 'font');
      const styleAttr = shorthand ? `style="font:var(${esc(shorthand.name)})"` : '';
      return `      <div class="spec">
        <div class="name">${esc(style.name)}</div>
        <p ${styleAttr}>The quick brown fox jumps over the lazy dog</p>
        <code class="var">${esc(shorthand ? shorthand.name : style.tokenPath)}</code>
      </div>`;
    })
    .join('\n');

  return `  <section>
    <h2>Typography</h2>
    <p class="lede">Each specimen is rendered with the style's own <code>font</code> shorthand variable, so the page is proof that the generated variables compose correctly.</p>
    <div class="specimens">
${specimens}
    </div>
  </section>`;
}

function shadowsSection(build) {
  if (build.shadows.length === 0) return '';
  const cards = build.shadows
    .map(
      (entry) => `      <article class="shadow-card">
        <div class="shadow-demo" style="box-shadow:var(${esc(entry.name)})"></div>
        <strong>${esc(entry.tokenName)}</strong>
        <code class="var">${esc(entry.name)}</code>
        <div class="arrow">${esc(entry.value)}</div>
      </article>`,
    )
    .join('\n');

  return `  <section>
    <h2>Shadows</h2>
    <p class="lede">Figma layer effects flattened to <code>box-shadow</code>. Figma's "radius" maps to the CSS blur radius.</p>
    <div class="shadows">
${cards}
    </div>
  </section>`;
}

function findingsSection(build) {
  const rank = { error: 0, warn: 1, info: 2 };
  const findings = [...build.warnings].sort((a, b) => rank[a.level] - rank[b.level]);
  if (findings.length === 0) {
    return `  <section>
    <h2>Findings</h2>
    <p class="lede">No findings. The token set is internally consistent.</p>
  </section>`;
  }
  const items = findings
    .map(
      (finding) =>
        `      <li class="${finding.level}"><strong>${esc(finding.level.toUpperCase())}</strong> <code>${esc(finding.token)}</code><br>${esc(finding.message)}</li>`,
    )
    .join('\n');
  return `  <section>
    <h2>Findings</h2>
    <p class="lede">Produced by the same validation pass that fails <code>npm run check --strict</code>.</p>
    <ul class="findings">
${items}
    </ul>
  </section>`;
}
