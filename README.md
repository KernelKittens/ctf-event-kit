![Kernel Kittens banner.](assets/branding/kernel-kittens-github-1280x400.png)

# Kernel Kittens CTF Event Kit

This public CTFd 3.8.7 event kit adds reliable solve delivery and participant-only automation.

## Kernel Kittens additions

Solve delivery uses a transactional outbox. A Rust event ledger records event activity, and the participant-only MCP keeps automation within the player-facing API.

## Participant MCP

The participant MCP provides `ctf_list_challenges`, `ctf_get_challenge`, `ctf_get_scoreboard`, and `ctf_submit_flag`. Staff and admin operations are excluded.

## Quick start

From the repository root, start the included Compose setup:

```sh
docker compose up
```

For stock CTFd setup and deployment options, see the [CTFd documentation](https://docs.ctfd.io/).

## Security

Report CTFd vulnerabilities privately to [support@ctfd.io](mailto:support@ctfd.io). Do not open them publicly. Project-specific issues may use this repository's issue tracker.

## Upstream CTFd

This repository is based on [CTFd 3.8.7](https://github.com/CTFd/CTFd). Kernel Kittens did not author CTFd. Stock platform documentation lives at [docs.ctfd.io](https://docs.ctfd.io/).

## License

Built by [Kernel Kittens](https://github.com/KernelKittens). Licensed under the [Apache License 2.0](LICENSE).
