# Adeno: long-term project goal

Recorded: 2026-09-07. User-confirmed direction, not a claim of completed implementation or nonprofit status.

## Mission

Make it easier for adult family caregivers to organize a loved one's health information, understand it in simple language, prepare questions for clinicians, and coordinate follow-through. Keep the experience kind, gentle, explanatory, and accessible to nontechnical people.

## Product and access

- Hosted-first: ordinary users do not need API keys, model selection, or technical setup.
- Keep the caregiver application open source, with an easy self-hosted path and user-owned provider keys as an advanced option.
- Support records and unorganized text intake, source-linked explanations, a dated timeline, family responsibilities, chat, and evidence-linked research.
- Help people prepare for clinical decisions; do not present AI as a diagnosing or prescribing clinician.

## Sustainable public-benefit funding

- Operate without a profit-distribution objective. Cover actual inference, search, storage, hosting, payment, compliance, and necessary operating costs.
- Pursue reputable fiscal sponsorship as the initial route to charitable fundraising. Consider an independent nonprofit later if scale and governance justify the overhead.
- Proposed funding model: voluntary contributions support a shared pool and strictly metered, fixed-period family AI allowances. Contributions should not buy clinical priority or preferential treatment.
- Issue or increase allowances only within reconciled funded capacity, after protecting existing commitments and operating/risk reserves. Never treat pending donations or hoped-for growth as spendable money.
- Keep existing records, saved explanations, tasks, and export available when AI allowances are exhausted. Use funded enrollment limits rather than promise unlimited access.
- Publish understandable aggregate income, operating costs, reserves, and usage breakdowns without exposing individual families or their medical information.

## Privacy and operations

- End-to-end encrypted health-record storage and family-controlled access are launch requirements for the intended hosted product, not claims about the current preview.
- Explicitly explain any plaintext shared with an AI provider. A conventional server-side AI proxy does not satisfy a promise that the operator cannot access the submitted content.
- Keep credentials, deployment authority, financial identities, and sensitive operational controls private. Private admin tooling may live separately from the open-source caregiver application; secrecy is not a substitute for authorization and auditing.
- Admin reporting should use minimum necessary financial/usage metadata, not access to health records.
- Never include real family medical records in software repositories, demos, or sponsor outreach.

## Fiscal sponsorship outreach shortlist

Candidates researched on 2026-09-07; acceptance, terms, geography, and current fees must be confirmed directly. No organization has agreed to sponsor Adeno.

1. [Hack Club / HCB](https://hackclub.com/fiscal-sponsorship): first outreach candidate for accessible fiscal sponsorship and transparent financial tooling. Published fee at research time: 7% of revenue. Confirm health-AI eligibility and ownership terms.
2. [Code for Science & Society](https://www.codeforsociety.org/become-a-fiscally-sponsored-project): first outreach candidate for public-interest technology sponsorship. Use the linked New Project Inquiry Form; request current fees and minimum commitments.
3. [Software in the Public Interest](https://www.spi-inc.org/projects/associated-project-howto/): established open-source sponsor; may be a later-stage fit because it targets substantial, significant projects. Published fee at research time: 5% of donations plus transaction costs. Informal inquiries: board@spi-inc.org.
4. [Family Caregiver Alliance](https://www.caregiver.org/about-fca/contact-us/): potential caregiver-feedback or partnership contact, not a verified fiscal sponsor.

Before choosing a sponsor, confirm permitted AI/hosting expenses, complete fees, minimum budget, fundraising/payment arrangements, intellectual-property ownership, exit/transfer terms, private-admin compatibility, and health-data/liability requirements. Sponsorship is not automatically funding or a grant.

## Decisions still open

- Operator country/state and legal entity.
- Sponsor selection and acceptance, or independent nonprofit formation.
- Initial funding, reserve policy, family allowance amounts, and enrollment capacity.
- Verified technical path combining the promised privacy boundary with enforceable operator-funded inference limits.

Do not claim registered nonprofit status, tax-deductible contributions, sponsor affiliation, production readiness, or complete E2EE until verified. Filing, account creation, outreach, publication, and deployment require their own authorization; database migrations always require explicit approval.

## Execution milestones

1. Prepare a synthetic demo, public project brief, and realistic operating budget for sponsor inquiries.
2. Select an eligible sponsorship/entity path and document payment and governance terms.
3. Implement and test funding accounting, reservations, payment reconciliation, and family quotas.
4. Complete multi-family access controls, encryption lifecycle, and inference privacy/spending validation.
5. Launch a small funded cohort, publish aggregate financial reporting, and expand only as reconciled funding permits.

The detailed operator implementation plan is maintained privately, outside tracked public documentation. This file records durable project direction; it does not authorize automatic execution or publication.
