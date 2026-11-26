# Implementation Plan
# Personal & Family Finance Manager

- Delivery model: incremental vertical slices
- Source control: Git inside the Docker development container at `/var/www/gas/personal_finance_v2/family-finance-antigravity`; Clasp runs only inside GitHub Actions
- Runtime distinction: Apps Script V8 is the application runtime; Node.js is a CI-only tool in GitHub Actions
- Mandatory workflow: one task → tests → documentation → Git commit
- Environment: separate DEV and PROD Apps Script projects and spreadsheets

## 1. Definition of Done (mandatory for every task)

A task is not complete until all applicable items are done:

1. **Implementation**
   - Scope matches the task.
   - No unrelated changes.
   - Input validation and error handling are included.
   - Security and financial invariants are preserved.

2. **Testing**
   - Unit tests for business logic.
   - Integration tests against a disposable DEV spreadsheet where applicable.
   - Manual test steps recorded for Apps Script behavior that cannot be fully automated.
   - Negative tests for authorization and invalid input.
   - Test result recorded in task notes or PR.

3. **Documentation**
   - Update relevant PRD, architecture, schema, implementation notes, README, or runbook.
   - Document configuration changes and migration steps.
   - Document known limitations.

4. **Git**
   - Review `git diff`.
   - Ensure no secrets, tokens, credentials, or production data are committed.
   - Commit the completed task with a meaningful message.
   - Do not combine multiple unrelated completed tasks into one commit.

If testing fails, do not mark the task complete and do not create a completion commit. A WIP commit is allowed only when explicitly requested.

## 2. Delivery phases

### Phase 0 — Repository and GitHub Actions foundation
Tasks:
- [x] Initialize the Git repository and source tree in the Docker development container at `/var/www/gas/personal_finance_v2/family-finance-antigravity`; run Antigravity CLI and Git there. (FFM-001)
- [x] Add `appsscript.json` and `.claspignore`. (FFM-002)
- [x] Add `package.json` only for CI-side test/lint scripts and development dependencies; no local Node.js installation is required. (FFM-003)
- [x] Add GitHub Actions CI workflow. (FFM-003)
- [x] In GitHub Actions, set up the approved Node.js LTS version and install test/lint tooling. (FFM-003)
- [x] In GitHub Actions, install Clasp and generate environment-specific `.clasp.json` at runtime. (FFM-004)
- [x] Configure Clasp authentication using GitHub Actions secrets. (FFM-004)
- [x] Configure automatic DEV synchronization from the development branch. (FFM-004)
- [x] Configure production deployment from protected `main`, with required approvals and deployment concurrency. (FFM-005 - adapted for GitHub Free Plan)
- [x] Add README explaining that AI-assisted development and Git operations run inside the Docker container, while all Node.js/Clasp execution happens in GitHub Actions. (FFM-001, FFM-004, FFM-005)

Exit criteria:
- A developer can clone the repository, edit files, and use Git without installing Node.js or Clasp.
- Pull requests run CI in GitHub Actions.
- A push/merge to the development branch synchronizes source to the DEV Apps Script project from GitHub Actions.
- A protected production release deploys using Clasp from GitHub Actions.
- No credentials or generated private environment configuration are tracked.

### Phase 1 — Authentication proof of concept (GO/NO-GO)

*Architecture Note (FFM-006 to FFM-008):* The previous GIS credential flow is rejected because Apps Script HtmlService uses dynamic `script.googleusercontent.com` origins incompatible with OAuth Authorized JavaScript Origins. The architecture replaces GIS with Google OAuth 2.0 Authorization Code Flow + OpenID Connect scopes (`openid email profile`), server-side code exchange, and ID token verification, entirely hosted on Apps Script URLs without Cloud Run or external servers.

*Callback URI Feasibility Gate:* The stable DEV Web App `/exec` URL (`https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`) is selected as the primary OAuth redirect URI; the documented `/usercallback` endpoint (`https://script.google.com/macros/d/<SCRIPT_ID>/usercallback`) is retained as a technical fallback. Google Cloud Console accepts `/exec` as a valid Authorized redirect URI.

Tasks:
- [x] 1. OAuth Redirect Flow Proof of Concept (FFM-006):
  - Replace GIS frontend with native "Sign in with Google" action.
  - Generate authorization URL with `response_type=code`, `scope=openid email profile`, and `prompt=select_account`.
  - Top-level redirect to Google OAuth authorization endpoint (`target="_top"`).
  - Receive callback in Apps Script `doGet(e)` via `/exec` URL.
  - Generate, validate, and immediately consume server-side state token (one-time CSRF/replay protection).
  - Confirm both personal Gmail accounts can complete the redirect and return.
  - Strict boundaries: No authorization code exchange yet (FFM-008), no application session creation (FFM-010), no client-supplied claims trusted.
- [x] 2. Server-Issued OAuth Challenge (FFM-007):
  - Cryptographically strong random state, OIDC nonce, and PKCE verifier (244 bits of entropy each via dual UUID concatenation).
  - PKCE S256 challenge calculation conforming strictly to RFC 7636; verified Google Web Client PKCE support.
  - Server-side challenge storage in `CacheService` with short TTL (300–600s) using SHA-256 hashed cache keys (`oauth_ch_<stateHash>`).
  - Atomic one-time challenge consumption using `LockService.getScriptLock()` to prevent duplicate concurrent callbacks and replay attacks.
  - Fail-closed security on cache eviction, missing challenge, expiration, or lock timeout.
  - Callback validation requiring state for both code reception and Google OAuth error responses.
  - Strict boundaries preserved: No code exchange or ID token verification yet (FFM-008), no application session issuance (FFM-010).
- [x] 3. Authorization Code Exchange and OIDC Verification (FFM-008):
  - Server-side authorization code exchange using `UrlFetchApp` with PKCE `code_verifier` and confidential `client_secret`.
  - Store Client Secret in Script Properties (`OAUTH_CLIENT_SECRET`), never exposed to Git, HTML, or browser JS.
  - OIDC ID token structure validation, Base64URL decoding, and header RS256 algorithm verification.
  - Comprehensive claim verification (`iss`, `aud`, `azp`, `exp`, `iat`, `nonce`, `sub`, `email`, `email_verified=true`).
  - Strict nonce binding to server-issued FFM-007 challenge preventing token replay and injection.
  - Server-side sanitized verified identity object creation without leaking tokens, secrets, or verifiers.
  - Documented Apps Script V8 cryptographic environment limitation (lack of native RSA signature verification).
  - Strict boundaries preserved: No account allowlist verification yet (FFM-009), no application session issuance (FFM-010).
- [x] 4. Account allowlist authorization using verified Google `sub` and email (FFM-009):
  - Server-side account allowlist authorization module (`AuthAllowlist` in `src/auth/allowlist.js`).
  - Evaluates verified Google identities against authorized accounts configured in Script Properties (`ALLOWED_EMAILS` / `ALLOWED_GOOGLE_SUBS`).
  - Strict default-deny policy; fails closed with `allowlist_unconfigured` if configuration is missing, empty, or contains only malformed addresses.
  - Exact, case-insensitive email matching requiring `emailVerified === true`.
  - Rejection of substring, prefix, suffix, and domain-only spoofing attempts.
  - Rejection of unconfigured email aliases (`+` tag notation).
  - Support for immutable Google `sub` matching without unverified field fallback.
  - Protection against sensitive data leakage: returns safe user error messages without exposing allowlist contents or tokens.
  - Integrated into `AuthConfig.validateCallback()` flow; bypass cannot occur via browser request tampering.
  - Boundaries preserved: No application session issuance (FFM-010), no financial data access.
- [ ] 5. Test both Gmail accounts in actual deployed DEV Web App (FFM-006 / FFM-009).
- [ ] 6. Negative security tests (expired code, wrong audience, wrong nonce, replayed state, disabled user).
- [ ] 7. Record token endpoint dependency, failure behavior, and latency.

*Note on FFM-006, FFM-007, FFM-008, & FFM-009 status:* Implementation and automated unit tests completed. Server-issued OAuth challenge generation, PKCE S256 parameterization, one-time consumption, authorization code exchange, OIDC ID token claim verification, and account allowlist authorization are fully implemented and unit tested. Live browser verification against deployed DEV Web App is pending Clasp sync to DEV and OAuth Client ID / Redirect URI configuration in Google Cloud Console.

Exit criteria:
- Both users can complete OAuth redirect and return to Apps Script `/exec`.
- State verification fails closed on missing, invalid, or replayed state.
- No client-supplied identity claim is trusted.
- No raw token appears in logs or Sheets.

**Hard gate:** Do not proceed to production authentication if the OAuth redirect flow or code exchange cannot operate reliably on Apps Script URLs. Do not bypass the gate by trusting email from the browser.

### Phase 2 — Session and authorization
Tasks:
- [x] 1. Implement random session token generation and hashed storage (FFM-010):
  - Cryptographically secure token generation (3x UUID = 96 hex chars, 366 bits of entropy).
  - Store only SHA-256 token hash in `PropertiesService` (persistent) and `CacheService` (read-through cache).
  - Server-side session validation with constant-time hash comparison.
  - Enforce 12-hour absolute lifetime and 30-minute idle timeout.
  - Safe client-side storage policy (`sessionStorage` only, never `localStorage`, never in URLs).
  - Gated exclusively behind successful FFM-008 OIDC verification and FFM-009 allowlist authorization.
  - Public API endpoint `apiValidateSession(token)` for protected operations.
- [x] 2. Implement logout, expiry, and revocation (FFM-011):
  - Server-side session revocation (`AuthSession.revokeSession`) with SHA-256 token hash lookup.
  - Immediate cache eviction and persistent `REVOKED` status update with `revokedAt` timestamp under `LockService`.
  - Idempotent repeated revocation returns `already_revoked`; safe handling of missing, malformed, and unknown tokens.
  - Public API endpoint `apiLogout(token)` callable via `google.script.run`.
  - Frontend logout button clears `sessionStorage` and redirects to login after server confirmation.
  - Graceful network failure handling: client clears token and redirects even if server revocation fails.
  - Revoked tokens permanently fail `validateSession` with `invalid_session`.
  - `ALLOWED_EMAILS` mandatory pre-deployment checklist documented in architecture.md Section 9.6.
- [x] 3. Implement OWNER/PARTNER roles and household authorization (FFM-012):
  - Server-side household membership and role resolution (`AuthAuthorization` in `src/auth/authorization.js`).
  - Strict separation from FFM-009 allowlist: allowlisted accounts without household membership are denied (`membership_not_found`).
  - Support for `HOUSEHOLD_MEMBERS_JSON` and flat `OWNER_*` / `PARTNER_*` Script Properties with fail-closed configuration validation (`authorization_configuration_error`).
  - Exact `OWNER` and `PARTNER` role definitions and permission matrix (`SHARED_PERMISSIONS` vs `OWNER_ONLY_PERMISSIONS`), default-deny policy.
  - Household data isolation rejecting browser-supplied `spreadsheetId`, `driveFolderId`, and cross-household IDs (`household_access_denied`).
  - Protected endpoints `apiGetHouseholdContext(token, requestScope)` and `apiAuthorizeOperation(token, permission, requestScope)`.
  - Immutable (`Object.freeze`) server-side authorization context and `authorizeAndExecute` guard.
- [x] 4. Implement server-side household context resolution (FFM-012).
- [ ] 5. Add authorization tests to every public API boundary.
- [ ] 6. Add security event logging with redaction.

Exit criteria:
- All protected APIs reject missing/invalid/expired/revoked sessions.
- PARTNER cannot change membership or owner-level settings.
- Both active users see the same household data.
- Browser cannot spoof actor, role, or household.

### Phase 3 — Database foundation
Tasks:
- [x] 1. Implement schema registry and schema version (FFM-013):
  - Authoritative, deeply frozen `SchemaRegistry` (`src/database/schema-registry.js`) defining all 29 canonical worksheets and exact header ordering from `database-schema.md` (`CURRENT_VERSION = 1`).
  - Header validation (`validateWorksheetHeaders`) detecting missing, unknown, renamed, and reordered columns.
  - Authoritative `SCHEMA_VERSION` tracking in Script Properties (`SchemaMigrations` in `src/database/migrations.js`) rejecting non-integer, negative, downgraded, or unknown future versions.
- [x] 2. Implement sheet creation/headers and versioned migration runner (FFM-013):
  - Versioned migration registry (`001_initial_canonical_schema`) with ascending version validation and pending migration selection.
  - Protected by `LockService.getScriptLock()` with mandatory release in `finally`.
  - Safe worksheet creation (`ensureWorksheet`) using batch `setValues()` and `setFrozenRows(1)`.
  - Preserves existing valid and populated worksheets without deleting sheets, clearing data, or silently removing unknown columns; fails safely on header mismatch or ambiguous unversioned pre-populated database (`ambiguous_unversioned_database`).
  - Controlled `OWNER`-only administrative endpoint `apiRunDatabaseMigrations(token)` gated by FFM-012 `'system.backup.manage'`.
- [ ] 3. Implement batched repository utilities (FFM-014).
- [ ] 4. Implement UUID and timestamp helpers.
- [ ] 5. Implement validation of same-household foreign references.
- [ ] 6. Seed the initial household and two members.
- [ ] 7. Add backup and restore procedure.

Exit criteria:
- DEV schema can be recreated repeatably.
- Migration scripts are idempotent.
- Repositories have unit/integration tests.
- Spreadsheet is not shared with partner.

### Phase 4 — Financial engine
Tasks:
- Account management.
- Category management.
- Transaction drafts.
- Ledger entry creation.
- Income and expense posting.
- Transfer posting.
- Opening balance.
- Split transactions.
- Void/reversal.
- Operation journal and idempotency.
- Reconciliation report.

Exit criteria:
- All ledger invariants pass.
- Duplicate requests do not duplicate entries.
- Interrupted posting can be recovered or marked NEEDS_REVIEW.
- Account balance reconciliation is correct.

### Phase 5 — Core UI and dashboard
Tasks:
- Responsive app shell and navigation.
- Dashboard cards and date filters.
- Account list and account detail.
- Transaction list, filters, create/edit forms.
- Confirmation for post and void.
- Error, loading, and empty states.

Exit criteria:
- Mobile and desktop smoke tests pass.
- UI does not expose spreadsheet IDs or internal secrets.
- Backend remains authoritative for validation.

### Phase 6 — Budgeting and planning
Tasks:
- Budget and category allocations.
- Actual vs budget.
- Rollover rules.
- Recurring rules.
- Bills and partial payments.
- Scheduled reminders.

Exit criteria:
- Only posted expenses count toward budget actuals.
- Recurring generation does not imply payment.
- Partial payments reconcile to bill outstanding amount.

### Phase 7 — Savings, debt, assets, investments
Tasks:
- Savings goals and contributions.
- Liabilities and debt payment allocation.
- Asset registry and valuation history.
- Investment holdings and transactions.
- Net worth calculations and double-counting rules.

Exit criteria:
- Internal transfers are not treated as expenses.
- Debt principal/interest/fee allocations reconcile.
- Net worth does not double-count investments.

### Phase 8 — Reports and exports
Tasks:
- Income/expense reports.
- Cash flow.
- Category analysis.
- Account balances.
- Budget realization.
- Debt and net worth.
- CSV export.
- PDF/XLSX only if justified.

Exit criteria:
- Report totals reconcile to ledger.
- Exports enforce household authorization.
- Exported files are private.

### Phase 9 — Security, reliability, and production readiness
Tasks:
- Full authorization matrix tests.
- Authentication negative tests.
- Input/output security review.
- Attachment security review.
- Quota and execution time review.
- Backup/restore drill.
- Reconciliation drill.
- Owner recovery procedure.
- Production runbook and incident process.

Exit criteria:
- No known critical/high security issues.
- Restore test succeeds.
- Production data is isolated from DEV.
- Owner approves the authentication residual risk.

### Phase 10 — Production deployment
Tasks:
- Create production Apps Script project and spreadsheet.
- Configure Script Properties and OAuth client.
- Configure production deployment.
- Configure GitHub production secrets.
- Deploy from protected `main`.
- Smoke test with both users.
- Verify rollback procedure.

Exit criteria:
- Stable production URL.
- Production spreadsheet remains private.
- Both users can authenticate.
- CI/CD and rollback are documented.

## 3. Suggested task breakdown

Use one task per independently reviewable unit. Suggested IDs:

| ID | Task | Status |
|---|---|---|
| FFM-001 | Initialize repository and source tree inside the Docker development container; Git runs there | Completed |
| FFM-002 | Add Apps Script manifest and ignore rules | Completed |
| FFM-003 | Add GitHub Actions CI with Node.js and test tooling | Completed |
| FFM-004 | Add GitHub Actions DEV sync using Clasp (runner only) | Completed |
| FFM-005 | Add protected production deployment using Clasp (runner only) | Completed |
| FFM-006 | Create GIS HtmlService proof of concept | Completed |
| FFM-007 | Implement server-issued login nonce | Completed |
| FFM-008 | Implement tokeninfo verification and claim validation | Completed |
| FFM-009 | Seed allowlisted Google identities | Completed |
| FFM-010 | Implement application session storage | Completed |
| FFM-011 | Implement logout, expiry, and revocation | Completed |
| FFM-012 | Implement household and role authorization | Completed |
| FFM-013 | Implement schema registry and migrations | Completed |
| FFM-014 | Implement repositories and batch I/O | Pending |
| FFM-015 | Implement account and category modules | Pending |
| FFM-016 | Implement transaction draft and validation | Pending |
| FFM-017 | Implement ledger posting and idempotency | Pending |
| FFM-018 | Implement transfers and reversal | Pending |
| FFM-019 | Implement dashboard | Pending |
| FFM-020 | Implement budgets | Pending |
| FFM-021 | Implement bills and recurring jobs | Pending |
| FFM-022 | Implement savings and debt | Pending |
| FFM-023 | Implement assets and investments | Pending |
| FFM-024 | Implement reports and exports | Pending |
| FFM-025 | Implement attachments and access checks | Pending |
| FFM-026 | Implement backup and restore | Pending |
| FFM-027 | Production hardening and deployment | Pending |

## 4. Docker development container and CI responsibility split

Canonical Docker workspace: `/var/www/gas/personal_finance_v2/family-finance-antigravity`. Antigravity CLI, project edits, repository inspection, and Git operations MUST run inside the configured Docker development container from this root. If the agent is not in that container/root, it must stop rather than use an alternate path. The host is only a connection point.

| Activity | Docker development container | Developer host | GitHub Actions |
|---|---|---|---|
| Run Antigravity CLI | Yes | No | No |
| Edit source and Markdown | Yes | No (connect to container editor) | No |
| Git status/diff/commit/push | Yes | No | Checkout and report |
| Node.js runtime | No | No | Yes |
| npm / npx | No | No | Yes |
| Clasp installation and execution | No | No | Yes |
| Unit tests / lint / syntax checks requiring Node.js | No | No | Yes |
| Apps Script DEV push | No | No | Yes |
| Apps Script PROD deployment | No | No | Yes |
| Clasp credentials | Never | Never | GitHub Actions secrets |

All Clasp configuration should be generated per environment inside the workflow. Do not require a developer to create or maintain a local `.clasp.json` or `.clasprc.json`. Do not install Node.js/Clasp in the development container just to run CI tasks.

## 5. Testing strategy

### Unit tests
Use the JavaScript test runner inside GitHub Actions for pure functions:
- Amount validation.
- Date and recurrence calculations.
- Split allocation.
- Ledger balance calculations.
- Permission evaluation.
- Token claim validation logic (mock the HTTP response; separately test real endpoint in DEV).

### Integration tests
Use a disposable DEV spreadsheet:
- Repository CRUD.
- Household reference validation.
- Posting and idempotency.
- Recovery after simulated partial writes.
- Audit event creation.
- Session lifecycle.

### Manual Apps Script tests
- GIS login in deployed HtmlService.
- Both Gmail accounts.
- OAuth consent and origin behavior.
- Script Properties.
- Drive attachment permissions.
- Time-driven trigger behavior.
- Production deployment and rollback.

### Security negative tests
- Missing session.
- Invalid session.
- Expired session.
- Revoked session.
- Wrong audience.
- Wrong issuer.
- Expired ID token.
- Unverified email.
- Unknown `sub`.
- Replayed nonce.
- Nonce expired/evicted.
- Partner attempts owner action.
- Cross-household record ID.
- Malformed/oversized payload.
- Repeated idempotency key.
- Direct browser attempt to supply a different user/role/household.

## 6. Git commit policy

Commit after every task has passed tests and documentation updates.

Recommended format:

```text
feat(auth): add Google GIS login proof of concept
feat(auth): validate Google ID tokens server-side
feat(auth): add application session lifecycle
feat(finance): implement ledger posting idempotency
test(auth): cover replay and invalid token cases
docs(security): document Gmail authentication constraints
```

Do not commit secrets, `.clasprc.json`, OAuth client secrets, production spreadsheet exports, or personal financial data.

## 7. Release checklist

- [ ] Authentication proof-of-concept gate passed.
- [ ] Both Gmail identities registered and tested.
- [ ] No client-side identity/role trust.
- [ ] Session lifecycle and revocation tested.
- [ ] All APIs enforce authorization.
- [ ] Production spreadsheet private.
- [ ] Attachment folder private.
- [ ] Ledger invariants tested.
- [ ] Idempotency/recovery tested.
- [ ] Backup/restore tested.
- [ ] CI passes.
- [ ] Production deployment uses stable deployment ID.
- [ ] Rollback documented and tested.
- [ ] Documentation updated.
- [ ] Git working tree clean.
- [ ] `ALLOWED_EMAILS` configured in Script Properties for target environment.
- [ ] `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` configured in Script Properties.
- [ ] Pre-deployment checklist in architecture.md Section 9.6 verified.
