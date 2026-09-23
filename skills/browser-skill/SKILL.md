---
name: browser-skill
description: Use when the learner asks to search the web, inspect live web pages, extract current web data, or operate a browser page. Requires the Tencent BrowserSkill `bsk` CLI and its connected browser extension.
---

# Browser Skill

Use Tencent BrowserSkill through the `bsk` CLI for live web search and browser operations. This skill is project-local and should be available to the single continuous EngBuddy conversation.

Use the available `bash` tool to run `bsk` commands directly. Do not tell the user to open a terminal and run `bsk` themselves when the agent can do it.

## Requirements

- `bsk` must be installed and available on `PATH`.
- The BrowserSkill extension must be connected to a Chromium browser.
- Do not use this skill for file, API, or database work that does not require a browser.
- Never extract cookies, tokens, passwords, or other credentials.

## Required Session Lifecycle

Every browser task must use one explicit session:

```text
bsk session start
# Capture the four-letter session id.
bsk snapshot --session <id>
# Run all other bsk commands with --session <id>.
bsk session stop <id>
```

Always stop the session, including after an error. Use `bsk session stop --all` only for emergency cleanup.

## Search and Read

For web search or current web data:

1. Start a session.
2. Navigate to the requested search engine or page with `bsk navigate`.
3. Run `bsk snapshot` before interacting.
4. Use refs from the latest snapshot for clicks, fills, and selections.
5. Re-snapshot after navigation or any major DOM change.
6. Prefer `bsk get-html` only when the accessibility snapshot does not expose the needed data.
7. Stop the session after the result is collected.

## Operate Pages

- Use `bsk click`, `bsk fill`, `bsk select`, and `bsk press` for normal page actions.
- Use `bsk request-help` when a human must complete login, CAPTCHA, OTP, or another confirmation step.
- Borrow a user tab only for the immediate requested operation, then return it or stop the session.
- Do not perform purchases, send messages, change permissions, upload files, or submit sensitive information without explicit user authorization.

## Source

This project skill follows Tencent BrowserSkill:
`https://github.com/Tencent/BrowserSkill`
