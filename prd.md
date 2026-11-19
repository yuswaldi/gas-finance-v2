# Product Requirements Document (PRD)
# Personal & Family Finance Manager

- Status: Baseline for implementation
- Product: Personal & Family Finance Manager
- Locale: Indonesia (`id-ID`)
- Currency: Indonesian Rupiah (`IDR`)
- Timezone: `Asia/Jakarta`
- Users: One household with two adult members (owner and partner)
- Platform: Google Apps Script V8 + Google Sheets + HTMLService
- Frontend: Native HTML, CSS, and JavaScript; zero runtime dependencies

## 1. Product vision

Build a secure, practical household finance application for a couple. Both members can record and review shared household finances through a web application. Bank and e-wallet transactions are entered manually; the application does not connect to internet banking.

The product is intended to become a complete household finance manager, not merely a transaction tracker.

## 2. Goals

1. Provide a reliable view of household cash flow, account balances, assets, liabilities, and net worth.
2. Record income, expenses, transfers, adjustments, and opening balances.
3. Support budgets, bills, recurring transactions, savings goals, debt, assets, and investments.
4. Allow two registered Gmail users to access the same household data.
5. Keep the underlying Google Sheets and Drive files private from application users.
6. Maintain a traceable audit history and recover safely from interrupted financial writes.
7. Keep source code in GitHub; run Antigravity CLI, project edits, and Git operations inside the Docker development container. Use Node.js and Clasp exclusively inside GitHub Actions for CI, Apps Script synchronization, and deployment.

## 3. Explicit product decisions

| Decision | Value |
|---|---|
| Google identity | Two personal Gmail accounts |
| Spreadsheet access | App-only; users do not receive spreadsheet access |
| Transaction visibility | All transactions are shared between household members |
| Banking integration | Manual entry |
| Database | Google Sheets |
| Backend | Google Apps Script V8 |
| Frontend | HTMLService and native browser APIs |
| Runtime frontend dependencies | None |
| Currency | IDR, integer Rupiah |
| Timezone | Asia/Jakarta |
| Deployment | Separate development and production Apps Script projects |
| Authentication | Google OAuth 2.0 Authorization Code Flow (OpenID Connect: openid email profile), verified server-side by Apps Script |
| Cloud Run | Not used |
| Authorization | Household membership and OWNER/PARTNER roles |

### Development and deployment tooling policy

- All AI-assisted development runs inside the Docker development container at `/var/www/gas/personal_finance_v2/family-finance-antigravity`. Antigravity CLI, project file operations, and Git operations run from that container and repository.
- The host is only used to connect to the configured container; agents must stop if they are not inside the canonical project root.
- Node.js, npm/npx, and Clasp are not installed or run in the development container or on the host.
- The GitHub repository is the source of truth.
- GitHub Actions provides the Node.js runtime, installs project tooling, runs automated checks, and runs Clasp to synchronize/deploy Apps Script.
- Apps Script V8 is the Google Apps Script server runtime; it is not Node.js and does not imply a local Node.js installation.
- Development deployment is triggered from the designated development branch; production deployment is restricted to protected `main`.
- Do not ask developers or agents to run `npm`, `npx`, `clasp`, or Node.js commands in the development container or on the host.

## 4. Users and roles

### OWNER
- First registered household member.
- Can manage household settings and member activation.
- Can manage all financial modules.
- Can revoke sessions for either member.
- Can view all household data.

### PARTNER
- Second registered household member.
- Can view and manage shared household financial data.
- Cannot add/remove household members or change owner-level security settings.
- Can revoke their own sessions.

Both roles can view all transactions because transaction privacy is `SHARED` only. Do not implement a private transaction mode in this release.

## 5. Scope and functional requirements

### 5.1 Authentication and household
- Sign in with an approved Google personal account.
- Only the two pre-registered Google identities may sign in.
- Use Google `sub` as the stable external identity key; email is an attribute, not the primary key.
- Create an application session after identity verification and membership checks.
- Support logout, session expiry, idle timeout, and revocation.
- Do not rely on `Session.getActiveUser().getEmail()` for consumer Gmail identity.
- Do not expose the spreadsheet to household members.

### 5.2 Dashboard
Display:
- Total financial account balances.
- Cash and e-wallet balances.
- Income and expenses for selected periods.
- Net cash flow.
- Budget utilization.
- Upcoming bills.
- Savings goal progress.
- Outstanding liabilities.
- Asset value and net worth.
- Recent transactions.

All dashboard totals must use posted records only and must avoid double-counting transfers, investment accounts, or linked assets.

### 5.3 Accounts
Support:
- Bank accounts.
- E-wallets.
- Cash wallets.
- Savings and deposit accounts.
- Investment accounts where appropriate.

Account properties include name, type, institution, masked account number, owner, ownership type (`SHARED` or `PERSONAL`), opening balance, opening date, active status.

### 5.4 Transactions and ledger
Support:
- Income.
- Expense.
- Transfer.
- Opening balance.
- Adjustment.
- Draft, posted, and void states.
- Categories, tags, notes, and attachments.
- Split transactions.
- Transaction search and date filtering.

Rules:
- Income creates an IN ledger entry.
- Expense creates an OUT ledger entry.
- Transfer creates OUT from the source and IN to the destination; it is not income or expense.
- Split components must sum exactly to the transaction total.
- Only posted entries affect balances and reports.
- Posted transactions are never physically deleted; use void/reversal and audit history.
- All records are household-scoped.
- Use integer Rupiah amounts; reject decimals and unsafe numeric values.

### 5.5 Categories
- Parent/child categories.
- Separate income and expense category types.
- Active/inactive status.
- Prevent deletion when referenced by posted transactions; allow deactivation.

### 5.6 Budgets
- Monthly and yearly budgets.
- Category-level allocations.
- Optional rollover.
- Alert thresholds.
- Actual spending is based on posted expense ledger entries only.
- Transfers are excluded.

### 5.7 Recurring transactions and bills
- Configurable schedule and recurrence.
- Upcoming bill list and reminders.
- Partial bill payments and payment history.
- A generated recurring occurrence is not automatically paid.
- Payment must be represented by a posted transaction.

### 5.8 Savings goals
- Goal amount, target date, linked account, contributions, progress.
- Moving money to a savings account is not a new expense.
- Contributions must not double-count cash flow.

### 5.9 Debt and installments
- Lender, principal, outstanding balance, rate, installment schedule.
- Payment components: principal, interest, fees.
- Debt payment records linked to financial transactions.
- Outstanding balance reconciles with posted principal payments.

### 5.10 Assets and investments
- Asset registry and valuation history.
- Investment holdings and transactions.
- Avoid double-counting an investment account and its holdings in net worth.
- Record valuation source/date and distinguish market estimates from cash balances.

### 5.11 Reports and exports
- Income and expense.
- Cash flow.
- Account balances.
- Budget vs actual.
- Category breakdown.
- Monthly/yearly comparison.
- Debt, assets, net worth, savings.
- Per-member reporting where meaningful.
- CSV export initially; PDF/XLSX can be phased in.

### 5.12 Notifications and jobs
- Upcoming bill reminders.
- Budget threshold alerts.
- Recurring transaction generation.
- Job execution logs and retry/recovery.
- Time-driven Apps Script triggers.

### 5.13 Audit and administration
- Audit login/logout and security events.
- Audit financial create/update/post/void actions.
- Record actor, timestamp, entity, and before/after values where practical.
- Never log passwords, ID tokens, session tokens, or secrets.

## 6. Non-functional requirements

### Security
- Server-side authentication and authorization on every protected operation.
- Allowlist exactly two registered Google identities initially.
- Validate ID token issuer, audience, expiry, email verification, and nonce.
- Use one-time nonce with short TTL and fail-closed behavior.
- Session tokens are cryptographically random; only hashes are stored.
- Spreadsheet and attachment folder are not shared with household users.
- Validate every ID and relationship against the active household.
- Use output encoding and input validation.
- No secrets in source control or client HTML.

### Reliability and financial correctness
- Ledger is the source of truth for account balances.
- Use LockService around posting and other critical writes.
- Use idempotency keys and an operation/recovery log.
- Do not assume multiple Sheets writes are atomic.
- Batch reads/writes using `getValues()` and `setValues()`.
- Reconciliation and backup/restore procedures are documented.

### Performance and limits
- Optimize for a low-volume household use case.
- Avoid per-cell Spreadsheet service calls.
- Paginate transaction history.
- Cache only non-critical derived data.
- Keep execution time and Apps Script quotas in view.
- Provide a migration path to a transactional database if usage or reliability needs outgrow Sheets.

### Usability
- Responsive desktop/mobile layout.
- Indonesian labels and IDR formatting.
- Clear confirmation for posting, voiding, and destructive administrative actions.
- Accessible forms and keyboard navigation.

## 7. Out of scope for initial release
- Automatic internet banking integration.
- Public registration.
- Multiple households per user.
- Private transactions.
- Direct spreadsheet access for either member.
- Multi-currency accounting.
- Complex tax accounting.
- Native mobile application.
- Public APIs for third parties.

## 8. Acceptance criteria

1. Only the two allowlisted Gmail identities can establish a session.
2. Invalid, expired, wrong-audience, unverified-email, replayed-nonce, or revoked-session requests are rejected.
3. No user can read or mutate data without a valid server-checked session.
4. Both household members can see the same posted transactions.
5. PARTNER cannot administer household membership or owner-level settings.
6. Transfers do not affect income/expense totals.
7. Account balances reconcile to opening balance plus posted IN minus posted OUT.
8. Split totals equal transaction totals.
9. Duplicate posting requests do not create duplicate ledger entries.
10. Interrupted posting can be detected and recovered safely.
11. Posted transactions cannot be physically deleted.
12. Spreadsheet and attachment files are not shared with partner accounts.
13. Development and production data/projects are isolated.
14. CI tests and security checks pass before production deployment.
15. Each completed implementation task has tests, documentation updates, and a Git commit.

## 9. Delivery approach

Implement in vertical slices. Each task must include:
- Implementation.
- Automated tests or documented manual test where automation is not feasible.
- Relevant documentation updates.
- Review of security and financial invariants.
- Git commit.

See `implementation-plan.md` for sequencing and exit criteria.
