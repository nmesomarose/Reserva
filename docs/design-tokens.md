# design-tokens-to-css

Converts `design-tokens.tokens.json` (a Figma Variables export) into CSS custom
properties, and keeps the design system's two-tier colour model intact all the
way through.

```bash
npm run build     # generate dist/
npm run check     # fail if dist/ is out of date (use in CI)
npm test          # 40 assertions covering parsing, naming, colour, output
```

No dependencies, no build step. The generator itself runs on Node 18 or newer;
`npm test` needs **Node 22+**, because that is when `node --test` learned to
expand the `tests/**/*.test.mjs` glob itself. One command, four artefacts.

| Output | Purpose | Audience |
| --- | --- | --- |
| `dist/tokens.css` | The custom properties. This is what apps import. | Front-end |
| `dist/tokens.report.json` | Every variable traced back to its Figma token, plus contrast measurements and findings. | Tooling, Storybook, docs sites, audits |
| `dist/TOKENS.md` | The reference: which variable to reach for, and why. | Front-end, design |
| `dist/tokens.preview.html` | A self-contained visual style guide. Open it from disk. | Design, review |

---

## The colour model, and why the tool is built around it

The token file has two kinds of colour, and they are not interchangeable.

```
Figma token file
├─ primitive colour collection      FOUNDATIONS  - raw palette, never used in the UI
│  ├─ key colour group              the one colour each family is anchored on
│  ├─ primary colour palette        steps 0, 10, 20 ... 100
│  ├─ secondary / tertiary / neutral / neutral variant / error palettes
│
└─ colour roles                    SEMANTIC     - intent, the only tier components may read
   primary, on primary, primary container, on primary container, ...
   └─ each role is an alias: {primitive colour collection.key colour group.primary key colour}
```

**Roles are what the UI is allowed to use. Primitives are what roles are built
from.** Four things in this repository enforce that boundary:

1. **Separate sections in the CSS.** Roles are emitted first under a
   `>> APPLY THESE IN THE UI` banner, primitives second under
   `>> FOUNDATIONS ONLY - DO NOT APPLY DIRECTLY IN THE UI`.
2. **Roles are emitted as `var()` references, not duplicated literals.** The
   alias graph authored in Figma survives into CSS:

   ```css
   --ds-color-primitive-key-primary: rgb(34 21 214);
   --ds-color-primary: var(--ds-color-primitive-key-primary);
   ```

   One line changed, one variable re-pointed, and every button, link and focus
   ring in the product follows. Nothing in the component layer has to know that
   the brand colour is `#2215d6`.
3. **Contrast is measured on every build.** Each `on ...` role is paired with
   the role it sits on and checked against WCAG 2.1, so a role that points at
   the wrong palette step is caught by the build rather than in review.
4. **The lint pass names the escape hatches.** A role holding a literal, a
   palette that no role consumes, or a missing `on ...` counterpart is reported
   on the console, in `TOKENS.md` and in the JSON report.

If you need a different trade-off -- for example a runtime that cannot resolve
nested custom properties -- build with `--role-values literal` and roles become
resolved colours instead. The default is `alias` because it is the only option
that keeps the theming contract intact.

### Adding a dark theme later

The role block is the seam. A dark theme is a second `:root` (or
`[data-theme="dark"]`) block that re-points the roles, not the primitives and
never the components:

```css
[data-theme='dark'] {
  --ds-color-primary: var(--ds-color-primitive-primary-80);
  --ds-color-on-primary: var(--ds-color-primitive-primary-10);
}
```

The token file currently contains no theme modes, so the tool does not invent
one. It gives you the seam and the contrast checking, and leaves the palette
decisions to design.

---

## Naming

Figma names are not CSS names. Five rules turn them into custom properties,
applied in order and documented so a rename in Figma produces a reviewable diff
rather than a mystery.

| # | Rule | Example |
| --- | --- | --- |
| R0 | kebab-case; a letter followed by digits is split | `fontSize` -> `font-size`, `secondary0` -> `secondary-0` |
| R1 | each group maps to a configured prefix | `colour roles` -> `color`, so `on primary` -> `--ds-color-on-primary` |
| R2 | leading words the group already says are dropped | `primary colour palette` + `primary 60` -> `--ds-color-primitive-primary-60` |
| R3 | trailing generic or group words are dropped | `spacing collection` + `base spacing` -> `--ds-spacing-base`; `error role` -> `--ds-color-error` |
| R4 | configured phrases are removed from the name | `primary key colour` -> `--ds-color-primitive-key-primary` |
| R5 | collisions get a numeric suffix **and a warning** | `--ds-color-error-2` |

R2 and R3 can never empty a name: they only fire while more than one word
remains, so a token called `spacing` inside a group called `spacing` survives
as `--ds-spacing`.

The group prefixes live in `tokens.build.config.json` and are merged over the
built-in defaults per key, so a project can rename one prefix without restating
the rest.

### What the current file produces

| Token | CSS variable |
| --- | --- |
| `colour roles / on primary container` | `--ds-color-on-primary-container` |
| `colour roles / error role` | `--ds-color-error` |
| `primitive colour collection / key colour group / tertiary key colour` | `--ds-color-primitive-key-tertiary` |
| `primitive colour collection / neutral variant colour palette / neutral variant 95` | `--ds-color-primitive-neutral-variant-95` |
| `spacing collection / extra large spacing` | `--ds-spacing-extra-large` |
| `typography / body large / fontSize` | `--ds-typography-body-large-font-size` |
| `effect / hard shadow` | `--ds-shadow-hard-shadow` |

---

## Value conversion

| Token type | Becomes | Note |
| --- | --- | --- |
| `color` | `rgb(34 21 214)`, plus `-rgb: 34 21 214` | `--color-format hex` gives `#2215d6`; `native` passes the source value through |
| `dimension` | `16px` | `--unit rem` divides by `--root-size` (16) and emits `1rem` |
| `number`, `string`, `boolean` | verbatim | |
| `custom-shadow` | `4px 6px 8px rgb(0 0 0 / 0.3216)` | Figma `radius` is the CSS blur radius; `spread` passes through; inner shadows get `inset` |
| `typography` | one variable per CSS property, plus a `font` shorthand | see the table below |

### Typography

A Figma text style has no `type` field, so the parser detects it by shape (a
group whose children are all known typographic properties). Each property maps
to a CSS property:

| Figma | CSS | Note |
| --- | --- | --- |
| `fontFamily` | `font-family` | quoted; `--font-stack` appends fallbacks |
| `fontSize` | `font-size` | dimension |
| `fontWeight` | `font-weight` | |
| `fontStyle` | `font-style` | |
| `fontStretch` | `font-stretch` | only meaningful for variable fonts |
| `letterSpacing` | `letter-spacing` | keeps negative values |
| `lineHeight` | `line-height` | |
| `textDecoration` | `text-decoration` | |
| `textCase` | `text-transform` | `upper` -> `uppercase`, `small caps` -> `small-caps` |
| `paragraphIndent` | `text-indent` | |
| `paragraphSpacing` | `margin` | no exact CSS equivalent; the closest thing |

Composites are **expanded, not collapsed**, so a heading can borrow a line
height without adopting the whole style:

```css
.title { font-size: var(--ds-typography-headline-large-font-size); }
.prose { font: var(--ds-typography-body-large-font); }  /* 500 16px/24px "DM Sans" */
```

`--no-font-shorthand` removes the shorthand; note that CSS `font` resets
properties it omits.

---

## Command line

```
node scripts/build-tokens.mjs [input.tokens.json] [options]
```

| Option | Default | Purpose |
| --- | --- | --- |
| `-i, --input <path>` | `design-tokens.tokens.json` | Token file to read |
| `-o, --out <dir>` | `dist` | Where to write |
| `--config <path>` | `tokens.build.config.json` | Build config; ignored if absent |
| `--prefix <string>` | `--ds-` | Prefix for every property |
| `--unit <px\|rem>` | `px` | Unit for dimension tokens |
| `--root-size <number>` | `16` | Root size used when `--unit rem` |
| `--color-format <modern\|hex\|native>` | `modern` | `modern` = `rgb(r g b / a)`, `hex` = `#rrggbb[aa]`, `native` = source value |
| `--role-values <alias\|literal>` | `alias` | Roles as `var()` references or resolved colours |
| `--font-stack <string>` | *(none)* | Fallback stack appended to every family |
| `--channels` / `--no-channels` | on | `-rgb` companion variables |
| `--alpha-vars` / `--no-alpha-vars` | off | `-alpha` companions for translucent colours |
| `--font-shorthand` / `--no-font-shorthand` | on | `font` shorthand per text style |
| `--indent <string>` | two spaces | Indentation inside `:root` blocks |
| `--sort <palette\|file>` | `palette` | Sort palette steps numerically, or keep file order |
| `--check` | off | Do not write; exit 1 if `dist/` differs from disk |
| `--stdout` | off | Print the stylesheet instead of writing |
| `--strict` | off | Exit 1 on any warning |
| `-q, --quiet`, `-v, --verbose` | | Output volume |
| `-h, --help`, `--version` | | |

Only options you actually type override the config file, so
`tokens.build.config.json` can set a house style that individual invocations
still adjust.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success (and, with `--check`, everything is up to date) |
| `1` | A build error, a stale `dist/` under `--check`, or a warning under `--strict` |
| `2` | Bad arguments, or the token file was not found |

### In CI

```yaml
- run: node scripts/build-tokens.mjs --check
```

The build is deterministic: no timestamps, no machine paths, palette steps
sorted numerically. Regenerating from an unchanged source produces byte
identical files, so `--check` only fails when the token file or the tooling
actually changed. Commit `dist/`; the CSS is the published artefact.

---

## What the validator checks

Findings are printed on the console, embedded in `TOKENS.md` and written to
`tokens.report.json`. `--verbose` shows them all; `--strict` turns warnings into
a failed build.

| Code | Level | Meaning |
| --- | --- | --- |
| `unresolved-reference` | error | An alias points at a token that does not exist |
| `reference-cycle` | error | Aliases form a loop |
| `unsupported-composite` | warn | A composite type with no CSS mapping yet |
| `unknown-type` | warn | A `type` the tool does not recognise |
| `role-not-aliased` | warn | A colour role holds a literal instead of referencing a primitive |
| `contrast` | warn | An `on ...` role is not legible on the role it sits on |
| `scale-not-monotonic` | warn | The spacing scale is not in ascending order |
| `negative-dimension` | warn | A negative dimension, which is usually a signed letter-spacing |
| `name-collision`, `duplicate-variable` | warn | Two tokens normalise to one property name |
| `orphan-on-role` | warn | An `on ...` role with no role to sit on |
| `unparseable-color` | warn | A colour in an unknown notation |
| `blend-mode` | warn | A Figma blend mode with no CSS equivalent |
| `empty-shadow` | warn | A shadow with no visible layers |
| `unknown-typography-property` | warn | A text-style key that is not a CSS text property |
| `palette-unused` | note | A palette no role references |
| `primitives-unused` | note | Values in a small group with no role pointing at them |
| `no-surface-roles` | note | No background / surface / outline roles exist |
| `missing-on-container` | note | A container role with no `on ... container` counterpart |
| `chained-reference` | note | A role resolves through more than one hop |
| `name-typo` | note | A duplicated character or word in a token name |
| `unusual-font-weight` | note | A weight that is not a standard step |

### Findings on the current token file

Five findings, all real, all fixable in Figma:

1. **The spacing scale is not monotonic.** `extra large spacing` is `24` but is
   listed before `large spacing`, which is `18`. Nobody can predict what
   `--ds-spacing-large` is worth without looking it up. (warning)
2. **The neutral and neutral-variant palettes have no roles.** 28 primitive
   colours are unreachable through the semantic layer. A product needs
   `background`, `surface`, `outline` and `text` roles; the raw ramps are
   already there, waiting for the layer that names them. (note)
3. **Five of the six key colours have no role.** Only `primary key colour` is
   used -- the `secondary`, `tertiary` and `error` roles point at palette steps
   instead, while `neutral` and `neutral variant` have no role at all. (note)
4. **No surface roles exist.** Same root cause as 2, stated as a system-level
   finding. (note)
5. **`effect / medium shadoww` is misspelled**, and the typo survives into
   `--ds-shadow-medium-shadoww`. The lint only flags patterns with no false
   positives, so this one is called out here rather than automatically. (manual)

---

## How the code is organised

Pure functions in, pure data out. Nothing under `scripts/lib/` touches the file
system, which is what makes the pipeline testable end to end.

| Module | Responsibility |
| --- | --- |
| `scripts/build-tokens.mjs` | CLI entry: I/O, config merge, console report, exit codes |
| `scripts/lib/args.mjs` | Option specification, parser, and `--help` generated from that same spec |
| `scripts/lib/parse.mjs` | Flatten the document into tokens; resolve the alias graph; cycle detection |
| `scripts/lib/naming.mjs` | The R0-R5 naming rules, palette steps, de-duplication |
| `scripts/lib/color.mjs` | Colour parsing and formatting, WCAG luminance and contrast |
| `scripts/lib/format.mjs` | Token value -> CSS value, including shadow and typography mapping |
| `scripts/lib/build.mjs` | Orchestration: sections, variables, palettes, contrast pairs, stats |
| `scripts/lib/validate.mjs` | Design-system lint rules |
| `scripts/lib/emit-css.mjs` | The stylesheet |
| `scripts/lib/emit-markdown.mjs` | `TOKENS.md` |
| `scripts/lib/emit-html.mjs` | `tokens.preview.html` |
| `scripts/lib/emit-report.mjs` | `tokens.report.json` |

The token file uses the pre-final DTCG keys (`value`, `type`, `description`).
The parser accepts `$value`, `$type` and `$description` as well, so the script
keeps working if the file is re-exported with the current specification.

### Data flow

```
design-tokens.tokens.json
  -> parse.mjs       132 flat tokens, aliases resolved, cycles reported
  -> build.mjs       variables named (R0-R5), grouped into sections, contrast measured
  -> validate.mjs    findings
  -> emit-*.mjs      tokens.css, TOKENS.md, tokens.preview.html, tokens.report.json
```

---

## Using the variables

```css
@import 'dist/tokens.css';

.card {
  padding: var(--ds-spacing-base);
  background: var(--ds-color-primary-container);   /* a role, not a primitive */
  color: var(--ds-color-on-primary-container);     /* its paired foreground */
  border-radius: var(--ds-spacing-small);
  box-shadow: var(--ds-shadow-soft-shadow);
}

.card__title {
  font: var(--ds-typography-title-medium-font);
  margin: 0;
}

/* Translucent overlays without hard-coding channels. */
.scrim {
  background: rgb(var(--ds-color-primitive-neutral-10-rgb) / 60%);
}
```

Review checklist for a pull request that touches colour:

- Does the component read a **role**, not a primitive?
- Is the foreground the `on ...` role paired with the background?
- Does a new primitive have a role that points at it, or a comment saying why not?
