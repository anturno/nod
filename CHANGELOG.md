# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.1]

### Added

- Agent loop with two tools, `bash` and `task_complete`, with approval before every command.
- Sign-in with a ChatGPT (Codex backend) or Grok subscription: `nod login`, `logout`, and `models`.
- Interactive shell with `/model`, `/clear`, `/verbose`, and `/exit`, plus one-shot mode for scripts and CI.
- Switching models across subscriptions mid-conversation.
- Eval suite with reference solutions (`bun run eval`).
