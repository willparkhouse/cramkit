# Supabase email templates

These are the source-of-truth HTML templates for the auth emails Supabase
sends. They live here for version control — Supabase has no API for
syncing them, so updating an email is a two-step manual process:

1. Edit the file in this folder.
2. Paste the contents into the matching template in
   **Supabase dashboard → Authentication → Email Templates**.

## Templates

| File | Supabase template | Fires when |
|---|---|---|
| `magic-link.html` | Magic Link | User requests a sign-in link |
| `confirm-signup.html` | Confirm signup | First-time signup if "Confirm sign up" is enabled |
| `change-email.html` | Change Email Address | User updates their email in settings |

The other three Supabase templates (Invite user, Reset password,
Reauthentication) are not used by cramkit's auth flow. If you ever turn
those features on, add the matching files here first.

## Notes

- All templates share the same brand frame: dark `#0a0a0f` background,
  card on `#141418`, accent button `#f46b45`.
- The logo is loaded from `https://cramkit.app/logos/cramkit-dark.png`.
  That URL must be publicly reachable or the email will show a broken
  image — verify after deploying logo assets.
- The `{{ .ConfirmationURL }}` token is the only Go template variable
  used. Supabase exposes a few others (`.Email`, `.Token`, `.SiteURL`,
  `.RedirectTo`) if you need them later.
