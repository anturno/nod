# Security Policy

## Supported versions

Only the latest version on `main` receives security fixes.

## Reporting a vulnerability

Please do not open a public issue.

Report it through GitHub's private vulnerability reporting: go to the [Security tab](https://github.com/anturno/nod/security/advisories/new) and choose **Report a vulnerability**. Include what you found, how to reproduce it, and the impact you expect.

You can expect an acknowledgement within 5 business days. We will keep you updated on the fix and credit you in the advisory unless you prefer otherwise.

## Scope

nod runs locally, stores sign-in tokens in `~/.nod` (or `NOD_HOME`) with mode 0600, and only talks to the provider you signed in to. Reports are especially relevant when:

- A command runs without approval (outside `--yes` or "allow for the session").
- Tokens leak into logs, command output, the model context, or files with looser permissions.
- The OAuth flow can be hijacked, for example through the localhost callback.
- Data is sent anywhere other than the signed-in provider.
