# Adeno UI library

Read `design.md` before changing a view. Canonical palette, spacing, type, motion and geometry are in `web/src/tokens.css`; reusable controls are in `web/src/ui/index.tsx`. Component styling follows legacy layout CSS in `ui/ui.css` so existing routes keep their layout ownership. Do not add a second UI framework for ordinary controls.

The welcome header links to `https://github.com/devk03/careledger` and reads a validated star count from same-origin `/api/public/project`. The production server and isolated preview fetch only that fixed public repository's metadata without credentials or user data. Counts cache for one hour per process; failures back off five minutes and retain a visibly marked last-known count. Without a known count, the link remains usable without inventing zero. This is a current count, not a historical analytics tracker. No GitHub Actions or database migration is needed. Browser tests stub the public counter; the interactive preview may make this one public-metadata request, never a health-record request.

## Safe local preview

```sh
cd web
npm run preview:ui
```

Open http://localhost:5175/design-system. The component gallery is development-only. This preview serves only hand-authored fictional API responses, has no backend proxy, and rejects all API mutations. It does not seed or migrate a database, read uploaded records, or call AI. Existing Docker on port 8080 is unchanged. The banner labels every preview page as synthetic. Forms on real page previews cannot save; gallery interactions change tab-local state only.

## Usage

```tsx
import { Button, ButtonLink, Field, Notice } from "./ui";

<Button variant="primary" type="submit" loading={working}>Save note</Button>
<ButtonLink variant="secondary" href="/records">Records</ButtonLink>
<Field id="nickname" label="Nickname" hint="Use a name your family recognizes."
  value={nickname} onChange={event => setNickname(event.target.value)} />
<Notice tone="error">The note could not be saved. Try again.</Notice>
```

Buttons act; ButtonLink navigates. Native props pass through. Default button type is `button`; submit must be explicit. Loading disables repeat activation and exposes `aria-busy`. Input/Select/Textarea allow existing label/description markup to remain without changing DOM structure. Field provides the standard connected label/helper/error arrangement. Never replace security consent, source citations, or authentication behavior during a styling migration.

All seven existing views consume shared primitives. Existing contextual CSS class names remain as compatibility hooks; new components should prefer explicit variants. AppHeader centralizes the six auth/workspace header instances; landing retains its distinct search header. Badge labels represent evidence state, never disease severity or prognosis.

The gallery demonstrates default, hover, focus, pressed, disabled, loading, error and success buttons, plus form validation and evidence badges. Use text plus state styling, immediate focus outlines, 44px control targets, and reduced-motion fallback. Validate at 320, 375, 414, 768 and 1280px. Automated axe checks are not a full accessibility certification.

Verification: `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`. Browser tests use only synthetic API responses and must never proxy to a real backend.
