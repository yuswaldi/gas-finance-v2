# Personal & Family Finance Manager

A secure, private personal and family finance web application designed for exactly one household with two registered personal Gmail users (Owner and Partner).

## 1. Project Overview

- **Product**: Personal & Family Finance Manager
- **Locale & Currency**: Indonesia (`id-ID`), Indonesian Rupiah (`IDR`, integer values)
- **Timezone**: `Asia/Jakarta` (`GMT+7`)
- **Backend Runtime**: Google Apps Script V8 (Google-hosted runtime)
- **Database**: Google Sheets (private to deployer; no direct user sheet access)
- **Storage**: Google Drive (private attachments folder)
- **Frontend**: Apps Script HTMLService with native HTML5, CSS3, and modern JavaScript (zero runtime frontend dependencies)
- **Authentication**: Google Identity Services (GIS) with server-side Google tokeninfo verification and one-time nonces
- **CI/CD**: GitHub Actions (Node.js LTS, Clasp, automated verification, and deployment)

## 2. Repository & Source Tree Structure

```text
family-finance-antigravity/
├── .claspignore               # Clasp deployment synchronization exclusion rules
├── .eslintrc.json             # ESLint configuration for CI static analysis
├── .github/
│   └── workflows/
│       ├── ci.yml             # GitHub Actions CI workflow (lint, syntax, unit tests)
│       ├── dev-sync.yml       # GitHub Actions DEV sync workflow (runner Clasp push)
│       └── deploy-prod.yml    # GitHub Actions Production deploy workflow (manual, stable URL)
├── .gitignore                 # Git ignore rules for secrets and development artifacts
├── AGENTS.md                  # Development instructions, boundaries, and AI conventions
├── appsscript.json            # Google Apps Script project manifest
├── architecture.md            # System architecture and technical baseline
├── database-schema.md         # Google Sheets schema specifications
├── implementation-plan.md     # Incremental task breakdown and release checklist
├── package.json               # CI manifest for development dependencies and test scripts
├── prd.md                     # Product requirements document
├── README.md                  # Project overview and developer guidelines
├── scripts/                   # CI scripts (JavaScript/Apps Script syntax check)
│   └── check-syntax.js
├── src/                       # Application source tree (Google Apps Script)
│   ├── auth/                  # Authentication, session management, and GIS tokeninfo verification
│   │   └── config.js          # GIS client configuration helper
│   ├── common/                # Shared utilities, constants, error handling, and response models
│   ├── database/              # Schema registry, migrations, repositories, and batch I/O
│   │   ├── migrations.js      # Versioned schema migration runner & worksheet initializer (FFM-013)
│   │   └── schema-registry.js # Canonical 29-worksheet schema registry (FFM-013)
│   ├── finance/               # Ledger engine, accounts, categories, transactions, budgets, bills
│   ├── jobs/                  # Time-driven triggers, reconciliation, and maintenance jobs
│   └── ui/                    # HTMLService templates, styles, and client-side logic
│       ├── index.html         # GIS sign-in interface and diagnostics UI
│       └── webapp.js          # Web App doGet entry point
└── tests/                     # CI unit test specs (executed via node:test in GitHub Actions)
    ├── auth-config.test.js    # AuthConfig unit tests
    └── ci-baseline.test.js
```

### Source Modules Breakdown
- `src/auth`: Authentication services, GIS Google tokeninfo verification, one-time login nonce lifecycle, and session management.
- `src/common`: Common utility functions, constants, validation helpers, standardized error models, and API response wrappers.
- `src/database`: Schema registry, versioning, migrations, batch spreadsheet operations, and domain repositories.
- `src/finance`: Financial engine covering double-entry ledger entries, accounts, categories, transactions, budgets, bills, recurring rules, and savings.
- `src/jobs`: Time-driven Apps Script trigger handlers, automated recurring bill generation, and reconciliation routines.
- `src/ui`: Apps Script HTMLService pages, component dialogs, CSS styling, and client-side JavaScript.

## 3. Mandatory Docker Workspace Boundary

All AI-assisted development and Git operations MUST run inside the designated Docker development container.

- **Canonical Project Root**:
  ```text
  /var/www/gas/personal_finance_v2/family-finance-antigravity
  ```
- **Environment Verification**:
  Before starting work, verify:
  ```bash
  pwd
  git rev-parse --show-toplevel
  git status --short
  ```
  Both `pwd` and the Git repository root must resolve exactly to the canonical project root.
- **Host Boundary**: The developer host is solely an access point for connecting to the Docker container; no project development commands should be executed directly on the host.

## 4. Tooling Boundary: Development Container vs GitHub Actions

| Activity | Docker Dev Container | Developer Host | GitHub Actions |
|---|---|---|---|
| Run Antigravity CLI | Yes | No | No |
| Edit source and Markdown | Yes | No (connect to container) | No |
| Git operations (`status`, `diff`, `commit`) | Yes | No | Checkout / report |
| Node.js / npm / npx runtime | No | No | Yes (LTS runner) |
| Clasp installation & execution | No | No | Yes (runner only) |
| Automated unit tests & linting | No | No | Yes |
| Clasp credentials & deployment secrets | Never | Never | GitHub Actions secrets |

- **Zero Local Node.js / Clasp Dependency**: Developers do not need to install or run Node.js, npm, npx, or Clasp locally or inside the Docker development container.
- **Strict Python Prohibition**: Python runtime, interpreter commands (`python`, `python3`), and `.py` scripts are strictly prohibited for project activities, inspection, and testing. Use native shell utilities (`bash`, `grep`, `find`, `sed`, `awk`, `git`).
- **GitHub Actions as CI/CD Engine**: GitHub Actions sets up Node.js LTS, installs CI dependencies, runs automated checks, generates environment-specific `.clasp.json` at runtime, and synchronizes source to Google Apps Script.

### DEV Synchronization Workflow

The DEV sync workflow (`.github/workflows/dev-sync.yml`) synchronizes code to Google Apps Script:
- **Triggers**: Automated on pushes to `develop` or `dev` branches; manual trigger via `workflow_dispatch`.
- **Pre-deployment Verification**: Runs Apps Script manifest validation, syntax check, ESLint, and unit tests before installing Clasp or pushing files.
- **Dynamic Clasp Configuration**: Installs `@google/clasp` in the runner, dynamically generates `.clasp.json` and `$HOME/.clasprc.json`, and cleans them up immediately on completion (`if: always()`).
- **Concurrency**: Deployments are serialized using the `dev-sync` concurrency group to avoid overlapping synchronization.

#### Required GitHub Secrets & Variables for DEV Sync

1. `CLASP_DEV_CLASPRC_JSON` (or `CLASPRC_JSON`) [Secret]: JSON output of `~/.clasprc.json` after authenticating via `clasp login`.
2. `DEV_SCRIPT_ID` (or `CLASP_DEV_SCRIPT_ID`) [Secret or Variable]: The Script ID of the DEV Google Apps Script project.

### Production Deployment Workflow (GitHub Free Plan Adapted)

The Production deployment workflow (`.github/workflows/deploy-prod.yml`) provides a guarded, manual release mechanism:
- **GitHub Free Plan Adaptation**: Does not require GitHub Protected Environments, environment reviewers, or paid approval gates. Security is enforced via manual `workflow_dispatch`, strict branch verification, automated CI gates, and concurrency locks.
- **Manual Trigger Only**: Can only be triggered manually via `workflow_dispatch`. Rejects execution from branches other than `refs/heads/main`.
- **Pre-deployment Verification**: Validates production configuration presence (rejects placeholders or DEV fallbacks) and executes full CI verification (manifest validation, syntax, lint, unit tests) against the exact commit before running `clasp push`.
- **Stable URL Preservation**: Updates the existing production deployment via `clasp deploy -i "$PROD_DEPLOYMENT_ID" -d "$RELEASE_DESCRIPTION"`, preserving the stable Web App URL without generating new deployment IDs.
- **Concurrency**: Deployments are serialized using the `production-deploy` concurrency group to prevent overlapping runs.
- **Credential Safety**: Ephemeral credentials in the runner are written to `$HOME/.clasprc.json` with `chmod 600` and purged unconditionally on job completion (`if: always()`).

#### Required GitHub Secrets & Variables for Production Deployment

1. `PROD_CLASP_CREDENTIALS` (or `PROD_CLASPRC_JSON`) [Secret]: Full JSON contents of `~/.clasprc.json` for the production deployer Google account.
2. `PROD_SCRIPT_ID` [Secret or Variable]: The Script ID of the Production Google Apps Script project.
3. `PROD_DEPLOYMENT_ID` [Secret or Variable]: The existing stable Deployment ID of the Production Web App.

## 5. Security & Financial Correctness Invariants

1. **Authentication Gate**: Server-side token verification using Google's `tokeninfo` endpoint with short-lived, single-use login nonces. Client claims are never trusted blindly.
2. **Session Security**: Cryptographically random opaque tokens; only SHA-256 hashes are persisted (`USER_SESSIONS`). Session checks are enforced on every protected backend operation.
3. **Authorization**: Household membership and role (`OWNER` vs `PARTNER`) resolved server-side. All transactions are shared between household members.
4. **Data Privacy**: Underlying Google Sheets and Drive files remain private to the deploying owner and are never shared directly with household users.
5. **Ledger Truth**: Double-entry ledger is the authoritative source for account balances (`Balance = Opening Balance + posted IN - posted OUT`).
6. **Integer Currency**: All financial amounts use integer IDR to prevent floating-point calculation anomalies.
7. **Safe Posting & Idempotency**: Critical writes employ `LockService`, unique idempotency keys, and an operations journal (`TRANSACTION_OPERATIONS`) for crash recovery.
8. **Immutability**: Posted transactions are never physically deleted; adjustments are handled via reversals/voids.

## 6. Specification & Documentation Reference

- [AGENTS.md](file:///var/www/gas/personal_finance_v2/family-finance-antigravity/AGENTS.md): Development instructions, commit policy, and tooling rules.
- [prd.md](file:///var/www/gas/personal_finance_v2/family-finance-antigravity/prd.md): Product requirements, features, roles, and scope.
- [architecture.md](file:///var/www/gas/personal_finance_v2/family-finance-antigravity/architecture.md): Technical architecture, GIS authentication design, and deployment model.
- [database-schema.md](file:///var/www/gas/personal_finance_v2/family-finance-antigravity/database-schema.md): Complete Google Sheets database schema and worksheet definitions.
- [implementation-plan.md](file:///var/www/gas/personal_finance_v2/family-finance-antigravity/implementation-plan.md): Phased roadmap, Definition of Done, and task tracking.
