import type { RoleId, Skill } from "@appforge/core";

const UPDATED = "2026-10-01T00:00:00.000Z";

function skill(id: string, name: string, description: string, roles: RoleId[], isDefault: boolean, body: string): Skill {
  return { id, name, description, roles, default: isDefault, body: body.trim(), files: [], builtIn: true, updatedAt: UPDATED };
}

/** Skills that ship with AppForge. Edit one on the Skills page to save your own version. */
export const BUILT_IN_SKILLS: Skill[] = [
  skill(
    "verify-before-done",
    "Verify before done",
    "Prove the change works instead of guessing (the #1 complaint about AI code is 'almost right').",
    ["coder", "integrator"],
    true,
    `
- Before you say you are finished, run the code you touched: the build, the relevant tests, or a quick script that exercises it.
- If something cannot be verified here, say exactly what is unverified and why.
- Re-read the acceptance criteria and check each one off explicitly in your final summary.
- Never leave TODOs, placeholder data, or commented-out code in place of a real implementation.
`,
  ),
  skill(
    "clean-code",
    "Clean, small changes",
    "Readable code that matches the project's existing conventions.",
    ["coder", "reviewer", "integrator"],
    true,
    `
- Match the surrounding code: naming, file layout, error handling, comment density.
- Small functions with names that say what they do; no dead code or unused exports.
- Handle errors where they happen; never swallow them silently.
- Keep the diff focused on the task. Don't reformat unrelated files.
- Prefer the standard library and existing dependencies before adding new ones.
`,
  ),
  skill(
    "secure-by-default",
    "Secure by default",
    "OWASP basics for every endpoint and form.",
    ["architect", "coder", "reviewer"],
    true,
    `
- Validate and type-check all input at the boundary (request bodies, params, query strings).
- Use parameterised queries / the ORM; never build SQL or shell commands from strings.
- Check authorisation on every endpoint that reads or changes user data, not just authentication.
- Never commit secrets; read them from environment variables. Don't log tokens or passwords.
- Hash passwords with a slow hash (bcrypt/argon2). Set secure, httpOnly cookies.
- Escape output in the UI; avoid dangerouslySetInnerHTML.
- Reviewers: treat any of the above as a blocker.
`,
  ),
  skill(
    "api-contract",
    "API contract first",
    "REST conventions and the OpenAPI contract as the source of truth.",
    ["architect", "coder", "reviewer"],
    true,
    `
- The OpenAPI contract in docs/ is the source of truth; frontend and backend both follow it. Update it in the same change if an endpoint must change.
- Plural nouns for resources (/api/todos), standard verbs, and status codes: 200/201/204, 400 validation, 401/403 auth, 404 missing, 409 conflict.
- One error shape everywhere: { "error": { "code": "string", "message": "string" } }.
- Paginate list endpoints that can grow (limit/offset or cursor).
- Reviewers: flag any drift between code and the contract.
`,
  ),
  skill(
    "accessible-ui",
    "Accessible UI",
    "Semantic, keyboard-friendly, testable interfaces.",
    ["coder", "reviewer", "test-author"],
    true,
    `
- Semantic HTML first (button, nav, main, label + input); ARIA only when HTML can't express it.
- Every interactive element is reachable and usable by keyboard and has a visible focus state.
- Text contrast at least 4.5:1; never rely on colour alone.
- Every form field has a label; errors are announced next to the field.
- Add data-testid only where role/label selectors are not enough.
`,
  ),
  skill(
    "test-what-matters",
    "Tests that matter",
    "A practical testing pyramid: fast unit tests, a few E2E flows.",
    ["test-author", "reviewer"],
    true,
    `
- Unit-test behaviour and edge cases (empty, invalid, not found, permission denied), not implementation details.
- One E2E test per critical user flow; select elements by role/label/data-testid.
- Tests must be deterministic: no sleeps, no real network, fixed dates/IDs.
- Test names describe the behaviour: "rejects an empty title with 400".
`,
  ),
  skill(
    "design-from-reference",
    "Design from reference images",
    "Turn reference screenshots into a faithful, responsive UI.",
    ["architect", "coder", "reviewer"],
    true,
    `
When reference images are attached (see .appforge/context/images/):
- Architect: describe the design system you see — colour palette (hex), typography scale, spacing unit, radii, shadows, and the component inventory — and the layout of each page, in a "Design" section of the plan.
- Coders: implement those tokens once (CSS variables / Tailwind theme) and reuse them. Match layout, hierarchy, spacing and alignment closely; use real content from the spec, not lorem ipsum.
- Make it responsive: the reference is one breakpoint; keep it usable on mobile.
- Reviewers: compare the result with the references and list visible differences.
`,
  ),
  skill(
    "minimal-ui",
    "Minimalist visual style",
    "Calm, minimal interfaces with lots of whitespace.",
    ["coder", "reviewer"],
    false,
    `
- Neutral palette with one accent colour; no gradients or heavy shadows.
- Generous whitespace, a clear type scale (e.g. 14/16/20/28) and consistent 4/8px spacing.
- One primary action per screen; secondary actions as quiet text buttons.
- Thin 1px borders or none; rely on spacing and alignment for structure.
`,
  ),
];
