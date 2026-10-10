# Security

Digital Bahi keeps businesses' bills, customers, payments and staff records, so
security problems are taken seriously.

## Reporting a problem

Please **do not** open a public issue for a security problem.

Report it privately on GitHub instead: open the repository's **Security** tab
and choose **Report a vulnerability**. Include what you found, how to reproduce
it, and what an attacker could do with it. You will get a reply as soon as the
report has been read; please give a reasonable time for a fix before telling
anyone else.

## What is in scope

- The API server (`apps/api`) and the database rules it relies on (row-level
  security, the restricted app role).
- The web app (`apps/web`), including the public order page (`/shop/...`).
- The Android app (`apps/mobile`) and the Windows/macOS/Linux installers
  (`installer`).

## What is already in place

How sign-in, sessions, encryption and the database rules work is described in
[docs/09-security.md](docs/09-security.md).
