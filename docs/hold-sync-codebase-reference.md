# Hold Sync — Codebase Reference (Running Doc)

Living reference of what every file in `hold-sync/` does and why it's built the way it is. The current architecture is one standalone Salesforce Case per Sapphire hold (`U_DDIHOLDLISTID`), with no parent/child grouping in the sync.

**Structural rule of the repo:** `src/` holds all application logic. `scripts/` holds standalone entrypoints that *import from* `src/` — they contain no business logic of their own. Root-level files are project configuration, not application code. `tsconfig.json` only compiles `src/**/*` (`rootDir: src`) — `scripts/` is intentionally excluded, which is why every script runs via `ts-node` directly rather than a compiled `dist/` file.

---

## Root level — project configuration

| File | Purpose | Notes |
|---|---|---|
| `package.json` | Declares dependencies and `npm run` shortcuts (`test:hold`, `check:oracle`, `import:file`) | `pino` is installed but currently unused anywhere in the code — all logging is plain `console.log`/`console.warn`. Either wire it in or drop the dependency. |
| `tsconfig.json` | TypeScript config — compiles `src/**/*` into `dist/` | `scripts/` is outside `rootDir`, so `npm run build` never touches it. `strict: true` is on, which matters given how much of this codebase deals with nullable Oracle fields. |
| `.env.example` | Template for the real (uncommitted) `.env` | Documents required vars: DDIVbNetApis connection info, Salesforce login URL/username/password/token, default owner username. |

---

## `src/` — application logic

| File | Purpose | Notes |
|---|---|---|
| `config.ts` | Single source of truth for all runtime settings. Loads `.env`, throws immediately if a required var is missing | The `required()` helper is a deliberate fail-loud pattern — this is the layer that should catch a misconfigured login URL or missing credential before it causes a confusing downstream error (e.g. the `INVALID_LOGIN` / username-lookup failures hit earlier in testing). `sinceDate` defaults to `'01-JAN-2020'` since there's no persisted watermark yet. |

**Shape returned by `getConfig()`** (inferred, not a named interface — worth promoting to one if it keeps growing):
```ts
{
  oracle: {
    baseUrl: string;
    oracleConnectName: string;
  };
  salesforce: {
    loginUrl: string;
    username: string;
    password: string;
    securityToken: string;
    defaultOwnerUsername: string;
  };
  sinceDate: string; // 'DD-MON-YYYY', defaults to '01-JAN-2020'
}
```
| `crosswalk.ts` | Static `U_HOLDCODEID → canonical Hold Type text` lookup (35 CS codes; Billing's 4 — IDs 1, 25, 41, 45 — deliberately excluded) | Pure data + one function (`canonicalHoldType`), no I/O or side effects. Mapping is done by numeric ID, not text, since hold-code text has been confirmed unreliable (typos, drift) while the ID is stable. |

**Shapes defined:**
```ts
type HOLD_TYPE_MAP = Record<number, string>; // U_HOLDCODEID -> canonical Hold Type text

function canonicalHoldType(
  holdCodeId: number,
  fallbackText: string
): string;
```
| `transform.ts` | `transformHolds()` — maps every `HoldRow` directly to one `HoldTicketRecord` and therefore one Case | There is no submission grouping or multi-hold aggregation. `externalId` is `U_DDIHOLDLISTID`; `submissionId` is retained as searchable Case context. Subject is the single canonical hold type, Description is that hold's NOTES, and `isResolved` comes from `U_OUTDATE`. |

**Shapes defined:**
```ts
interface HoldTicketRecord {
  externalId: string;              // U_DDIHOLDLISTID; Case upsert key
  submissionId: string;            // U_SUBMISSIONID; not unique in Salesforce
  doctorId: string | null;         // -> Account.Name
  subAccountId: string | null;     // -> Contact.SubAccountId__c
  doctorName: string | null;       // independently nullable
  doctorPhone: string | null;      // independently nullable
  patientName: string | null;      // independently nullable
  patientPhone: string | null;     // independently nullable
  holdType: string;                // canonical, via crosswalk.ts
  notes: string | null;            // NOTES; usually blank
  sourceTool: string;              // CREATETOOL
  createdBy: string;               // CREATEBY
  createdDate: Date;               // CREATEDT
  isResolved: boolean;             // U_OUTDATE is populated
  resolvedBy: string | null;       // U_HOLDRELEASEDBY
  resolvedDate: Date | null;       // U_OUTDATE
}

function transformHolds(
  rows: HoldRow[],
  subAccountIdBySubmission: Map<string, string | null>,
  contactInfoBySubmission: Map<string, SubmissionContactInfo>
): HoldTicketRecord[];
```
| `sync.ts` | Reads Sapphire data through DDIVbNetApis, fetches changed holds, loads submission-level lookup data, maps each changed hold to one ticket, then upserts one Case per ticket | Subaccount and doctor/patient calls remain batched by distinct submission ID. The old per-submission sibling reload is gone because no Case-level aggregate exists. |

### `src/services/` — external system clients

| File | Purpose | Notes |
|---|---|---|
| `oracle-client.ts` | `OracleHoldClient` — reads Sapphire data through the DDIVbNetApis REST API | `fetchChangedHolds()` returns the exact holds to sync. `fetchSubmissionSubAccountIds()` and `fetchSubmissionContactInfo()` enrich them by distinct submission ID. `fetchHoldsBySubmissionId()` supports submission-level testing. `fetchHoldById()` is unavailable until DDIVbNetApis adds a matching endpoint. Patient DOB and SSN are deliberately never returned. |

**Shapes defined:**
```ts
interface HoldRow {
  U_DDIHOLDLISTID: string;
  U_SUBMISSIONID: string;
  U_HOLDCODE: string;
  U_HOLDCODEID: number;
  NOTES: string | null;
  CREATEDT: Date;
  CREATEBY: string;
  CREATETOOL: string;
  U_OUTDATE: Date | null;
  U_HOLDRELEASEDBY: string | null;
  U_DOCTORID: string | null;
}

interface SubmissionRow {
  SUBMISSIONID: string;
  U_DOCTORID: string | null;
  U_SUBACCOUNTID: string | null;
}

interface SubmissionContactInfo {
  doctorName: string | null;
  doctorPhone: string | null;
  patientName: string | null;
  patientPhone: string | null;
}

class OracleHoldClient {
  constructor(config: { baseUrl: string; oracleConnectName: string });
  connect(): Promise<void>;                                          // no-op, kept for interface parity
  close(): Promise<void>;                                             // no-op
  fetchChangedHolds(sinceDate: string): Promise<HoldRow[]>;
  fetchHoldById(holdId: string): Promise<HoldRow | null>;
  fetchHoldsBySubmissionId(submissionId: string): Promise<HoldRow[]>;
  fetchSubmissionSubAccountIds(
    submissionIds: string[]
  ): Promise<Map<string, string | null>>;
  fetchSubmissionContactInfo(
    submissionIds: string[]
  ): Promise<Map<string, SubmissionContactInfo>>;
}
```
| `salesforce-client.ts` | `SalesforceHoldClient` — resolves shared Salesforce IDs/lookups and upserts one standalone Case per hold | Cases match on unique external ID `Sapphire_Hold_Id__c`; `Sapphire_Submission_Id__c` remains a non-unique searchable value. No `Hold_Sub_Ticket__c` records are written. Existing Case Status is queried before upsert so source-side resolution can close the matching Case without resetting open holds to `New`. |

**Shapes / constants defined:**
```ts
// Salesforce API name constants — change here if Setup field names ever differ
const CASE_OBJECT = 'Case';
const CASE_EXTERNAL_ID_FIELD = 'Sapphire_Hold_Id__c';
const CASE_RECORD_TYPE_NAME = 'CS Ticket';

class SalesforceHoldClient {
  constructor(config: {
    loginUrl: string;
    username: string;
    password: string;
    securityToken: string;
    defaultOwnerUsername: string;
  });
  login(): Promise<void>;
  upsertTicket(ticket: HoldTicketRecord): Promise<void>;
}

// Current Case upsert payload shape:
{
  Sapphire_Hold_Id__c: string;       // unique external-ID match key
  Sapphire_Submission_Id__c: string;
  OwnerId: string;
  RecordTypeId: string;
  Status?: 'New' | 'Resolved';
  AccountId: string | null;
  ContactId: string | null;
  Subject: string;                   // this hold's canonical type
  Description: string | null;        // this hold's NOTES
  Department__c: 'Customer Service';
  Doctor_Name__c: string | null;
  Doctor_Phone__c: string | null;
  Patient_Name__c: string | null;
  Patient_Phone__c: string | null;
}
```

**Status truth table:**

| Existing Case? | Sapphire hold resolved? | Case Status sent |
|---|---|---|
| No | No | `New` |
| No | Yes | `Resolved` |
| Yes | No | Omitted; preserve Salesforce value |
| Yes | Yes | `Resolved` only when current Case Status is not already `Resolved`; otherwise omitted |

`Hold_Sub_Ticket__c`, `Block_Resolve_with_Open_Subtickets`, and `Open_Sub_Ticket_Count__c` still exist in Salesforce but are not referenced or written by this sync. Future write-back will resolve exactly one Sapphire hold per Case, a natural 1:1 mapping with no parent/child resolution coordination.

---

## `scripts/` — standalone entrypoints (no logic of their own)

| File | Purpose | Notes |
|---|---|---|
| `check-oracle-connection.ts` | Bare connectivity test against DDIVbNetApis | Fetches changed holds through the same REST endpoint used by a real sync. |
| `test-single-hold.ts` | Fetches and syncs one hold or all holds on one submission for focused testing | Every returned hold becomes its own Case. It uses the same batched subaccount and doctor/patient contact-info lookups as `sync.ts`. |
| `import-from-file.ts` | Working fallback/testing path using the documented 15-column pipe-delimited export | Doctor/patient fields come from each spooled line; Contact lookup remains null because the format does not carry `U_SUBACCOUNTID`. Every line becomes one Case even when multiple lines share a submission ID. |

---

## Open threads to fold in as they're resolved

- [ ] `pino` — wire it in or remove the dependency
- [ ] `test-single-hold.ts` — Node v24/`ts-node` crash, not yet re-verified with the workaround
- [x] One-Case-per-hold architecture — no submission grouping, sibling aggregation, or child-object writes remain
- [x] Case payload — hold external ID, submission ID, single-hold details, contact data, and source-aware resolution Status implemented
- [ ] Persisted watermark, cron/Temporal scheduling, and write-back — all explicitly deferred past v1.0/v1.1, not forgotten
