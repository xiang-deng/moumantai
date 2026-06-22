# Security Policy

Moumantai is a self-hosted framework: your server holds your data and your LLM
credentials. We take security reports seriously.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, report privately via [GitHub Security Advisories](https://github.com/xiang-deng/moumantai/security/advisories/new),
or email **xiang.deng@neocognition.io**. Include:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if you have one),
- affected component (server, a client, the protocol) and version/commit.

We aim to acknowledge reports within a few days and will keep you updated on a
fix. Please give us a reasonable window to address the issue before any public
disclosure.

## Scope & expectations

This is an early-stage, self-hosted project. A few things worth knowing:

- **Credentials stay server-side.** LLM tokens and API keys live in
  `.moumantai/.env` (written `chmod 600`) and are never sent to clients or
  plugin apps. The configured agent backend uses them to authenticate with its
  provider; prompts and relevant app context may be sent to that provider.
- **Pairing is on by default.** The server only accepts allowlisted devices
  (`pairingRequired: true`); device enrollment is gated by a time-boxed window.
  Treat disabling pairing as a localhost-only convenience.
- **You own deployment.** There is no hosted Moumantai service — exposing your
  server to a network is your responsibility. Put it behind TLS / a trusted
  network and keep pairing enabled.
- **Plugin apps are trusted code.** Apps you install run **in-process, with no
  sandbox** — an installed app has the same privileges as the server itself
  (filesystem, network, your per-app databases). Treat installing one exactly
  like adding a code dependency: only install apps you have written or reviewed.
  The LLM inside a normal app turn is constrained (it cannot author or run
  arbitrary code), but the app's own code is not.
- **Outbound requests are not egress-filtered.** A plugin app's `http` client
  and the dev-only, host-gated edit-agent web tools can reach any address the
  server can — including link-local/metadata endpoints. There is no SSRF
  allowlist; this follows from the trust model above (app code is trusted; the
  edit agent is an operator tool). Don't point either at untrusted input from a
  host with sensitive internal-network reach.

Reports that depend on disabling built-in protections (e.g. running with
pairing off on a public network), or on a plugin app you installed behaving
maliciously, are out of scope.
