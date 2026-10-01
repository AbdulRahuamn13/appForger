export interface StoryTemplate {
  label: string;
  title: string;
  body: string;
  acceptance: string;
}

/** Starters for common stories; edit before planning. */
export const STORY_TEMPLATES: StoryTemplate[] = [
  {
    label: "CRUD feature",
    title: "Manage <things>",
    body: "Users can create, list, edit and delete <things>. Each <thing> has: name (required), description, created date.",
    acceptance: "- The list shows all <things>, newest first, with an empty state\n- Creating with an empty name shows a validation error\n- Edits and deletes are reflected immediately\n- API returns 404 for unknown ids",
  },
  {
    label: "Sign up & log in",
    title: "Accounts: sign up, log in, log out",
    body: "Email + password accounts. Passwords are hashed. Sessions use a secure httpOnly cookie. Pages: sign up, log in; a user menu with log out.",
    acceptance: "- Signing up with an existing email shows an error\n- Wrong password shows a generic error\n- Protected pages redirect to log in\n- Log out ends the session",
  },
  {
    label: "Page from a design",
    title: "Build the <page> page from the reference",
    body: "Build the page shown in the attached reference image(s). Match layout, spacing, colours and typography. Use real content from the app, not lorem ipsum.",
    acceptance: "- Layout matches the reference on desktop\n- Works on a 375px wide screen\n- Interactive elements have hover and focus states",
  },
  {
    label: "Dashboard",
    title: "Dashboard with key numbers",
    body: "A dashboard page showing the key numbers for <domain> (totals, recent activity) with a simple chart.",
    acceptance: "- Numbers match the data in the API\n- Shows a loading and an empty state\n- The chart has a legend and accessible labels",
  },
  {
    label: "Fix a bug",
    title: "Fix: <what is broken>",
    body: "Steps to reproduce:\n1. \n2. \n\nExpected: \nActual: ",
    acceptance: "- The steps above no longer reproduce the bug\n- A test covers the case so it can't come back",
  },
  {
    label: "Add tests",
    title: "Add tests for <area>",
    body: "Add unit tests for <area> and one end-to-end test for its main user flow. Don't change behaviour.",
    acceptance: "- New tests pass\n- Failure cases are covered (invalid input, not found)",
  },
];
