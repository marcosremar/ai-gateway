# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

As we're in pre-1.0 development, only the latest minor version receives security updates.

## Reporting a Vulnerability

We take the security of AI Gateway seriously. If you discover a security vulnerability, please follow these steps:

### **DO NOT** open a public GitHub issue

### 1. Email us directly

Send details to the project maintainers with:
- A description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- Any suggested fixes (optional)

### 2. GitHub Security Advisory (preferred)

Use the [GitHub Security Advisories](https://github.com/marcosremar/ai-gateway/security/advisories) to privately report the issue.

### 3. Response timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 7 days
- **Fix timeline**: Depends on severity
  - Critical: Patch within 7 days
  - High: Patch within 14 days
  - Medium: Patch within 30 days
  - Low: Patch within next release cycle

### 4. What to expect

- We will acknowledge receipt of your report within 48 hours
- We will keep you informed of our progress
- We will credit you in the release notes (unless you prefer to remain anonymous)
- We will notify you when the fix is released

## Security Measures

### What we protect against

1. **API Key Exposure**: All API keys are stored server-side, never logged or exposed in responses
2. **Authentication**: HMAC-signed tokens for GPU authentication, API key validation for all endpoints
3. **Input Validation**: All user inputs are validated with Zod schemas
4. **Rate Limiting**: Per-endpoint rate limiting to prevent abuse
5. **Request Size Limits**: Max body size enforced (100MB default)
6. **Security Headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`
7. **Dependency Security**: Regular audits of dependencies for known vulnerabilities

### Known attack surface

- `/v1/speech` — Audio input endpoint (potential injection via crafted audio)
- `/v1/chat/completions` — LLM proxy (prompt injection risk)
- GPU provider clients (RunPod, Vast.ai, Modal) — Credential handling
- Auth token signing/verification (`src/auth/`)
- Environment variable handling (secret leakage)

## Best Practices for Users

1. **Never commit `.env` files** — They are in `.gitignore` for a reason
2. **Rotate API keys regularly** — Use different keys for dev/staging/prod
3. **Use minimum permissions** — Provider API keys should have only required scopes
4. **Enable rate limiting** — Set `RATE_LIMIT_RPM` in production
5. **Monitor logs** — Watch for unusual patterns in request logs
6. **Keep updated** — Update to latest version for security patches

## Contact

- GitHub: [@marcosremar](https://github.com/marcosremar)
- Email: Use GitHub Security Advisories for confidential reports
