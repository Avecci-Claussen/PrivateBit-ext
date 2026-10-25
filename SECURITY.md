# Security

PrivateBit holds keys to real money. Please report anything that could leak keys, coins or privacy.

## How to report

- Use GitHub's **Report a vulnerability** button on this repository (private security advisory). This is the preferred way.
- Do not open a public issue for a security problem, and do not post details anywhere public before a fix is out.

Please include the version (Settings shows it), the browser and version, the steps to reproduce, and what you expected. A proof of concept on a throwaway wallet is ideal. Never send recovery words, passwords or a wallet export, not even from a test wallet you still use.

## What happens next

- We aim to confirm receipt within 3 working days and to give a first assessment within 10.
- Fixes for problems that can lose funds or keys come first, then privacy leaks, then the rest.
- We credit reporters in the release notes unless you ask us not to.

## In scope

- The extension in this repository: key storage, signing, Silent Payments scanning, Payjoin, website connections (provider, content script, approval windows) and the release build.
- The release gate (`scripts/check-dist.mjs`) missing a secret or test hook in `dist/`.

## Out of scope

- Third party services you choose to use (block data services, mailboxes, relays, price services), except where PrivateBit sends them more than it says it does.
- Attacks that need malware already running on your computer or full control of your browser profile.

## Supported versions

Only the latest release gets security fixes.
