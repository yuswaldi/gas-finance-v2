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
- [ ] Configure production deployment from protected `main`, with required approvals and deployment concurrency. (FFM-005)
- [x] Add README explaining that AI-assisted development and Git operations run inside the Docker container, while all Node.js/Clasp execution happens in GitHub Actions. (FFM-001, FFM-004)

Exit criteria:
- A developer can clone the repository, edit files, and use Git without installing Node.js or Clasp.
- Pull requests run CI in GitHub Actions.
- A push/merge to the development branch synchronizes source to the DEV Apps Script project from GitHub Actions.
- A protected production release deploys using Clasp from GitHub Actions.
- No credentials or generated private environment configuration are tracked.

### Phase 1 — Authentication proof of concept (GO/NO-GO)
Tasks:
1. Create OAuth Web Client ID for GIS.
2. Configure GIS in HtmlService.
3. Create server-issued one-time nonce.
4. Implement Apps Script tokeninfo verification.
5. Validate `aud`, `iss`, `exp`, `iat`, `email_verified`, `sub`, and nonce.
6. Create allowlist for the two Gmail identities using verified Google `sub`.
7. Test both Gmail accounts in actual deployed DEV Web App.
8. Test expired, malformed, wrong-audience, wrong-nonce, replayed-nonce, unverified-email, and disabled-user cases.
9. Record tokeninfo endpoint dependency, failure behavior, and latency.

Exit criteria:
- Both users can log in reliably.
- All negative tests fail closed.
- No client-supplied identity claim is trusted.
- No raw token appears in logs or Sheets.

**Hard gate:** Do not proceed to production authentication if GIS cannot operate reliably inside the deployed HtmlService sandbox or if tokeninfo validation cannot be made reliable. Do not bypass the gate by trusting email from the browser.

### Phase 2 — Session and authorization
Tasks:
- Implement random session token generation.
- Store only token hashes.
- Implement session expiry, idle timeout, logout, and revocation.
- Implement OWNER/PARTNER roles.
- Implement server-side household context resolution.
- Add authorization tests to every public API boundary.
- Add security event logging with redaction.

Exit criteria:
- All protected APIs reject missing/invalid/expired/revoked sessions.
- PARTNER cannot change membership or owner-level settings.
- Both active users see the same household data.
- Browser cannot spoof actor, role, or household.

### Phase 3 — Database foundation
Tasks:
- Implement schema registry and schema version.
- Implement sheet creation/headers.
- Implement batched repository utilities.
- Implement UUID and timestamp helpers.
- Implement validation of same-household foreign references.
- Seed the initial household and two members.
- Add backup and restore procedure.

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
| FFM-005 | Add protected production deployment using Clasp (runner only) | Pending |
| FFM-006 | Create GIS HtmlService proof of concept | Pending |
| FFM-007 | Implement server-issued login nonce | Pending |
| FFM-008 | Implement tokeninfo verification and claim validation | Pending |
| FFM-009 | Seed allowlisted Google identities | Pending |
| FFM-010 | Implement application session storage | Pending |
| FFM-011 | Implement logout, expiry, and revocation | Pending |
| FFM-012 | Implement household and role authorization | Pending |
| FFM-013 | Implement schema registry and migrations | Pending |
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
