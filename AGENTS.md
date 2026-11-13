# AGENTS.md
# Antigravity CLI — Project Instructions

These instructions apply to the entire Personal & Family Finance Manager repository.

The project root is:

```text
/var/www/gas/personal_finance_v2/family-finance-antigravity
```

Before performing any task, verify that the current working directory is the project root.

The agent MUST NOT create project artifacts outside this directory.

## 1. Project context

Build a secure personal and family finance web application for exactly one household with two registered personal Gmail users.

Technology stack:
- Google Apps Script V8 backend.
- Google Sheets database.
- Apps Script HTMLService frontend.
- Native HTML, CSS, and JavaScript.
- Zero runtime frontend dependencies.
- Clasp for local development and Apps Script synchronization.
- GitHub Actions for CI/CD.
- Currency: integer IDR.
- Timezone: Asia/Jakarta.

Do not introduce Laravel, PHP, MySQL, SQL Server, React, Vue, Bootstrap, jQuery, or a frontend runtime framework unless the user explicitly changes the stack.

Read these documents before implementation:
1. `prd.md`
2. `architecture.md`
3. `database-schema.md`
4. `implementation-plan.md`

If instructions conflict, ask the user before changing a recorded product decision. Security requirements in this file are mandatory.

## 2. Mandatory task workflow

**Every completed task MUST be followed by testing, documentation updates, and a Git commit.**

For each task:

1. Inspect the repository and relevant documentation.
2. State the exact task scope and acceptance criteria in the plan.
3. Implement only that task.
4. Run relevant automated tests.
5. Run manual DEV checks when required.
6. Review `git diff` and inspect changed files.
7. Update documentation, schema, configuration examples, and test notes as applicable.
8. Check for secrets, tokens, credentials, production data, and unrelated changes.
9. Create a meaningful Git commit.
10. Report files changed, tests run/results, documentation updated, and commit hash.

Do not declare a task complete if tests fail or documentation is not updated. Do not create the completion commit until the task passes. If a task is blocked, explain the blocker and leave it uncommitted unless the user explicitly requests a WIP commit.

Never combine multiple unrelated tasks into one commit.

## 3. Git commit policy

Use one commit per completed task. Prefer Conventional Commit messages, for example:

```text
feat(auth): add Google GIS login proof of concept
feat(auth): validate Google ID tokens server-side
feat(auth): add application session lifecycle
feat(finance): implement transaction posting
test(finance): cover transfer and idempotency rules
docs(architecture): document authentication limitations
```

Before committing:
- Run tests and applicable lint/syntax checks.
- Run `git diff --check`.
- Inspect `git status --short`.
- Ensure no secrets or financial data are staged.
- Confirm documentation updates are included.

Do not amend, rebase, force-push, or rewrite shared history unless explicitly requested.

## 4. Security rules

### Authentication
- Use Google Identity Services for personal Gmail sign-in.
- Verify Google ID tokens server-side using the Google tokeninfo endpoint from Apps Script, as documented in `architecture.md`.
- Validate `aud`, `iss`, `exp`, `iat`, `email_verified`, `sub`, and one-time nonce.
- Fail closed on endpoint error, malformed response, missing claims, invalid claims, or nonce failure.
- Never trust decoded token claims or email values supplied by the browser.
- Never use `Session.getActiveUser().getEmail()` as the only authentication mechanism for personal Gmail.
- Do not auto-register arbitrary Google accounts.
- Only registered Google `sub` identities may access the household.
- Do not log ID tokens, session tokens, nonce values, OAuth secrets, or credentials.

### Sessions
- Generate cryptographically strong random opaque tokens.
- Store only token hashes server-side.
- Enforce expiry, idle timeout, logout, and revocation.
- Never put tokens in URLs.
- Do not persist bearer session tokens in localStorage.
- Check session on every protected backend operation.

### Authorization
- Resolve actor, role, and household from the validated session on the server.
- Never trust browser-supplied `user_id`, `role`, or `household_id`.
- Validate every referenced record belongs to the active household.
- OWNER can administer household membership/security settings.
- PARTNER can operate shared finance modules but cannot administer membership or owner-only settings.
- All transactions are shared. Do not implement private transaction visibility without explicit approval.

### Database and Drive
- Spreadsheet and attachment folder are private to the deploying owner.
- Do not share them with household users.
- Do not accept arbitrary spreadsheet IDs or Drive folder IDs from the browser.
- Use repositories and service layers; do not write Sheets directly from UI handlers.
- Protect against formula injection when exporting untrusted text to CSV/Sheets.
- Validate upload type, size, and filenames.
- Never create public Drive links.

## 5. Financial correctness rules

- Ledger entries are the source of truth for account balances.
- Balance = opening balance + posted IN - posted OUT.
- Income is IN; expense is OUT.
- Transfer is paired OUT/IN and excluded from income/expense.
- Split components must sum exactly to transaction total.
- Only posted transactions affect balances and budget actuals.
- Posted transactions must not be physically deleted; use reversal/void and audit.
- Savings transfers are not additional expenses.
- Do not double-count investment accounts and portfolio valuations.
- Use integer Rupiah amounts; do not use floating-point arithmetic for financial amounts.
- Use UUIDs, never row numbers as identifiers.
- Validate all foreign references against the same household.

## 6. Google Sheets reliability rules

- Use `LockService` for critical posting operations.
- Remember LockService does not provide multi-sheet ACID transactions.
- Use idempotency keys and `TRANSACTION_OPERATIONS` journal.
- Recovery must inspect existing writes before retrying.
- Do not blindly retry partially completed financial writes.
- Use batch `getValues()` and `setValues()` calls.
- Avoid per-cell service calls.
- Cache only non-authoritative data.
- Keep schema migrations versioned, repeatable, and idempotent.
- Add reconciliation and backup/restore procedures.

## 7. Apps Script implementation conventions

- Apps Script `.gs` files share a global scope; avoid duplicate global function and variable names.
- Use clear namespaces/objects for modules.
- Keep public `google.script.run` entry points small.
- Do not expose repository methods directly to the browser.
- Do not assume Node.js modules, `require`, filesystem access, or browser APIs exist in Apps Script server code.
- Keep client code in HTMLService files and server code in `.gs` files.
- Validate and normalize all inputs on the server.
- Return structured, minimal error responses; never leak stack traces or sheet internals to users.
- Keep Script Properties environment-specific.
- Use explicit OAuth scopes and least privilege.

## 8. Frontend conventions

- Native HTML/CSS/JavaScript only; no runtime dependencies.
- Use semantic HTML and accessible labels.
- Use `google.script.run` success/failure handlers.
- Do not put secrets in HTML or JavaScript.
- Treat all server-returned strings as untrusted; use `textContent` rather than unsafe `innerHTML` for user data.
- Provide loading, empty, validation, and error states.
- Format IDR for display only; keep underlying values as integers.
- Do not calculate authoritative balances or permissions solely in the browser.

## 9. Testing requirements

For each task, select and run appropriate tests:
- Unit tests for pure business logic.
- Integration tests against a disposable DEV spreadsheet.
- Manual tests for Apps Script deployment, GIS, triggers, and Drive permissions.
- Negative authorization/security tests.
- Financial invariant and reconciliation tests.

At minimum, authentication tests must cover:
- Valid registered user.
- Unknown Google `sub`.
- Wrong audience.
- Wrong issuer.
- Expired token.
- Unverified email.
- Missing or expired nonce.
- Replayed nonce.
- Tokeninfo endpoint failure.
- Expired/revoked app session.
- Partner attempting owner-only operation.

Financial tests must cover:
- Income and expense.
- Transfer pair.
- Split total.
- Duplicate idempotency key.
- Interrupted/partial posting recovery.
- Void/reversal.
- Cross-household reference rejection.

## 10. Environment and deployment

- Keep DEV and PROD Apps Script projects, spreadsheets, Drive folders, and Script Properties separate.
- Never test against production financial data.
- Production deployment only from protected `main`.
- Serialize deployments using GitHub Actions concurrency.
- Use the existing stable deployment ID to preserve the Web App URL.
- Keep Clasp credentials and OAuth secrets in secure secret storage.
- Never commit `.clasprc.json` or credential files.
- Smoke-test after deployment and document rollback.

## 11. Agent behavior

- Prefer small, reviewable tasks.
- Do not silently change architecture or add paid services.
- Do not claim a security property that has not been implemented and tested.
- Clearly distinguish implemented behavior, assumptions, and known limitations.
- Ask one concise question if an essential product/security decision is missing.
- Do not invent credentials, script IDs, spreadsheet IDs, Google account emails, or deployment IDs.
- Do not access or alter production resources without explicit user authorization.
- Do not create a Git commit before tests and documentation updates are complete.
