# Security Policy

## Supported Versions

`momo-agentic` is pre-1.0 and follows a rolling release model. Security fixes
are applied to the latest published `0.x` release only.

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| < 0.2   | :x:                |

We strongly recommend always running the most recent release.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report them privately through one of the following channels:

- **GitHub Security Advisories** (preferred): open a private report via the
  ["Report a vulnerability"](https://github.com/snlangsuan/momo-agentic/security/advisories/new)
  button on the repository's *Security* tab.
- **Email**: digital.solution.1@hotmail.com

Please include as much of the following as you can:

- A description of the vulnerability and its impact
- Steps to reproduce, or a proof-of-concept
- The affected version(s) and environment (Bun/Node version, OS)
- Any suggested mitigation or fix

## What to Expect

- **Acknowledgement** within 5 business days.
- An assessment of the report and an expected timeline for a fix, typically
  within 10 business days.
- Notification when the fix is released. With your permission, we will credit
  you in the release notes.

We ask that you give us a reasonable amount of time to address the issue before
any public disclosure.

## Scope

`momo-agentic` is a provider-agnostic agent **library** with zero runtime
dependencies. It does not ship infrastructure, network services, or LLM
provider SDKs — those are injected by the user through ports. When reporting,
please focus on issues within the library itself, for example:

- Unsafe handling of tool calls, tool schemas, or model output
- Prompt/tool-injection paths that the library could reasonably mitigate
- Memory or data leakage between agent runs
- Supply-chain concerns in the published package contents

Issues that originate in a user-supplied `LanguageModel` adapter, tool
implementation, or other injected infrastructure are outside the scope of this
library, though we're still happy to hear about them.
