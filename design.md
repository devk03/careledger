# Adeno design system

One shared system for the caregiver application. Extend this system instead of inventing a theme for each page.

## Direction

Modern-minimal, warm Coral with editorial welcome pages. Adult caregivers first: kind, gentle, explanatory, never childish. Preserve Workbench layouts for caregiver views and paired heading/form layouts for authentication. Content/gallery pages use a readable long-document layout. The welcome page uses a serif headline and original artwork beside the main action.

Granola is a public inspiration reference, not a copied design or licensed asset source. Adeno retains its own wordmark, palette, page structure and evidence vocabulary.

## Typography and color

Geist Variable is the body, control and working-page heading face. Fraunces Variable is the Adeno wordmark and welcome/auth display face, always upright. System monospace is reserved for code and identifiers. No italic headings. All color and font declarations use named tokens in `web/src/tokens.css`.

Warm paper, raised paper, dark brown ink, one restrained Coral action accent. Green indicates a saved/reviewed state, never a medical prognosis. Error/warning/info always include readable text. Focus outlines are immediate and distinct from filled controls.

## Layout and spacing

Use the existing named 4-point spacing scale. Shared control height is 44px minimum; body/control text is 16px, supporting text at least 14px. App headings use the shared fluid page-title scale rather than individual giant landing-page sizes. Keep source text and dates readable. Use tabular numerals for dates/counts. No decorative card nesting or invented metrics.

## Components

`web/src/ui/index.tsx` owns Button, ButtonLink, Input, Select, Textarea, Notice, Badge, AppHeader and Field. Native semantics remain controlling: links navigate, buttons act, labels name fields. Preserve form behavior, IDs, autocomplete, required flags, CSRF and privacy acknowledgement.

Buttons share primary/secondary/quiet variants. Loading disables duplicate activation and exposes aria-busy. Fields preserve constant border width through focus/error. Notices announce errors; empty error slots stay in the layout. Do not encode confirmation in color alone.

User-approved refinement: preserve input geometry and press animation. Buttons use a warm-ink keyboard outline instead of blue; input focus retains its existing treatment. Retry/error buttons keep dark ink on a warm tinted surface through default, hover and press; no white flash or white text swap.

## Original imagery

Self-hosted editorial artwork may appear on welcome and authentication pages; no artwork behind forms or clinical evidence. Use original generated garden and notebook illustrations, not Granola assets or real family photos. Images are decorative, not documentation of real patients. Store provenance/prompts in `docs/image-provenance.md`, supply intrinsic dimensions and optimized responsive WebP files, and keep all medical-record content out of image prompts. The gallery and UI preview remain synthetic only.

Current selection: notebook only. The garden was rejected by the user; do not restore it. Keep the approved notebook's landscape framing and high-density source. The public GitHub link and cached star count belong in the welcome navigation, not clinical panels.

## Motion

No page-load or scroll reveals. Subtle press feedback only; reduced-motion disables spatial transforms. Never animate focus outlines or use transition: all. Existing native controls retain keyboard behavior.

## Scope and validation

All pages share fonts, accent, controls, focus treatment, header rhythm and spacing. Existing page-specific grid layouts remain. The development-only gallery uses hand-written fictional content and makes no AI or record requests. Preview mode must not proxy to the backend. Validate 320, 375, 414, 768 and 1280px layouts, keyboard focus, serious/critical axe checks, component behavior tests, frontend lint and build.

## Exports

Canonical CSS: `web/src/tokens.css`; root `tokens.css` is a portable import facade. React: `web/src/ui/index.tsx`. Usage and state examples: `docs/ui-library.md` and development route `/design-system`. No new styling framework is required; avoid competing token systems.

### CSS

```css
@import "./web/src/tokens.css";
```

### Tailwind v4 adapter (optional, not installed)

Import canonical tokens first. Example role mappings, not a second palette:

```css
@theme inline {
  --color-background: var(--color-paper);
  --color-foreground: var(--color-ink);
  --color-primary: var(--color-accent);
  --font-sans: var(--font-body);
  --spacing-page: var(--space-lg);
}
```

### DTCG core palette snapshot

For external token tooling only; regenerate from canonical CSS when values change.

```json
{
  "color": {
    "paper": { "$type": "color", "$value": { "colorSpace": "oklch", "components": [0.975, 0.012, 65], "alpha": 1 } },
    "ink": { "$type": "color", "$value": { "colorSpace": "oklch", "components": [0.245, 0.025, 48], "alpha": 1 } },
    "accent": { "$type": "color", "$value": { "colorSpace": "oklch", "components": [0.54, 0.145, 35], "alpha": 1 } }
  }
}
```

### shadcn-compatible role aliases (optional, not installed)

For consumers expecting complete CSS color values; older HSL-component configurations need their own conversion.

```css
:root {
  --background: var(--color-paper);
  --foreground: var(--color-ink);
  --card: var(--color-paper-raised);
  --card-foreground: var(--color-ink);
  --primary: var(--color-accent);
  --primary-foreground: var(--color-accent-ink);
  --muted: var(--color-paper-soft);
  --muted-foreground: var(--color-ink-soft);
  --border: var(--color-rule);
  --input: var(--color-rule-strong);
  --ring: var(--color-focus);
  --radius: var(--radius-md);
}
```
