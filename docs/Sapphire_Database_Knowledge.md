# Sapphire Database Knowledge (Running Doc)

Living reference of what's been confirmed about Sapphire's Oracle schema. Update this as you keep exploring — it's meant to be the single source of truth for table/column facts, separate from the project scoping/decisions doc.

**Schema/owner confirmed:** `SAPPHIRE`

---

## Naming convention note

Earlier internal diagrams (built via MS Access, linked over ODBC) showed table names prefixed with `SAPPHIRE_` (e.g. `SAPPHIRE_SUBMISSION`, `SAPPHIRE_U_DOCTOR`). **This prefix does not exist in the real Oracle catalog** — confirmed by direct query. It was Access's own labeling of the linked tables, not the actual database names. When searching or referencing tables going forward, use the bare names below (`SUBMISSION`, `U_DOCTOR`, etc.), not the `SAPPHIRE_`-prefixed versions from those diagrams.

**The `U_` prefix has a precise, confirmed mechanism** (not just a general "custom field" convention as originally guessed): it's added automatically by Sapphire when a table is created as an **SDC** — Sapphire's own mechanism for defining a table specifically so it can be added to a menu and given CRUD screens inside LV Explorer. `U_DDIHOLDLIST`, `U_HOLDREASON`, `U_DOCTOR`, and `U_PATIENT` are all SDCs — which is *why* the Problem Log menu (Hold Pending Records, Holdreason List, Records On Hold, etc.) exists: those menu items are the CRUD screens the SDC mechanism generates for these exact tables. Non-prefixed tables (`SUBMISSION`, `SAMPLE`) are core LabVantage product tables, not created this way.

**Implication for write-back:** confirms `U_DDIHOLDLIST` has a human-facing CRUD form in Sapphire's UI — it does **not** by itself confirm a programmatic/automatable write path exists. The PowerBuilder API's Service/Action object framework (Application tier, per the api.doc) is the one plausible avenue for triggering an update without a human clicking through the form — worth asking specifically whether that's actually usable for this table, rather than assuming the SDC mechanism alone solves automated write-back.

---

## Tables confirmed to exist (schema `SAPPHIRE`, filtered by keyword)

Found via `all_tables` for `%SUBMISSION%`, `%SAMPLE%`, `%DOCTOR%`, `%PATIENT%`, `%HOLD%`:

| Table | Likely purpose | Status |
|---|---|---|
| `SUBMISSION` | Order/submission header — the top-level entity a hold points to | **Confirmed via `DESC`.** Key columns: `SUBMISSIONID` (PK), `U_DOCTORID`, `U_PATIENTID`, `U_SUBACCOUNTID` (matches the existing sync's Contact join key exactly). |
| `SUBMISSION_CHANGE_LOG` | Audit/change log for submissions | Found, not yet inspected |
| `SAMPLE` | Sample-level entity, sits under Submission | Confirmed 1:many under Submission via `SAMPLE.U_SUBMISSIONID` (seen in the `U_DDICUSTOMERHOLD` view definition). **Not needed for the join strategy — see recommendation below.** |
| `SAMPLE_CHANGE_LOG` | Audit/change log for samples | Found, not yet inspected |
| `U_DOCTOR` | Doctor info | Seen in earlier relationship diagram |
| `U_DOCTOR_CHANGE_LOG` | Audit/change log for doctors | Found, not yet inspected |
| `A_U_DOCTOR` | Unknown — possibly an archive/active-flag variant of `U_DOCTOR` | Found, not yet inspected |
| `U_PATIENT` | Patient info | Seen in earlier relationship diagram |
| `U_PATIENTLOG` | Unknown — possibly patient-level activity log | Found, not yet inspected |
| `U_PATIENTREG` | Unknown — possibly patient registration record | Found, not yet inspected |
| `U_BLOODSAMPLE` | Sample-type child table (blood) | Seen in earlier relationship diagram |
| `U_FECALSAMPLE` | Sample-type child table (fecal) | Seen in earlier relationship diagram |
| `U_HAIRSAMPLE` | Sample-type child table (hair) | Seen in earlier relationship diagram |
| `U_URINESAMPLE` | Sample-type child table (urine) | Seen in earlier relationship diagram |
| `U_WATERSAMPLE` | Sample-type child table (water) | Seen in earlier relationship diagram |
| `U_OTHERSAMPLE` | Sample-type child table (catch-all/other) | Found, not yet inspected |
| `U_DDIHOLDLIST` | **The hold event table — fully documented below** | Confirmed, columns known |
| `U_HOLDREASON` | **Confirmed: the master hold-code table.** Full list of 39 codes obtained — see below. | Confirmed, contents known |

**Not in this list, and not in `all_tables` at all:** `U_DDICUSTOMERHOLD`. Its columns exist (found via `all_tab_columns`), but it's absent from `all_tables` — strongly suggests **it's a view, not a physical table**. Confirm with:
```sql
SELECT owner, view_name FROM all_views WHERE view_name = 'U_DDICUSTOMERHOLD';
SELECT text FROM all_views WHERE view_name = 'U_DDICUSTOMERHOLD';  -- shows its defining query
```
If it turns out to be a view built specifically around the Billing-only hold codes (Credit Hold, ABN, PECOS, Medicare), that's a stronger confirmation of the Billing/CS routing split than a plain table would be — a view usually exists because someone already needed to isolate exactly that subset.

**Tables seen only in older diagrams, not yet independently re-confirmed in this Oracle instance:** `SDIDATA`, `SDIDATAAPPROVAL`, `SDIDATAITEM` (results data), `U_QCREFRANGES`, `U_QCSTAGING` (QC data). Lower priority — not directly relevant to the hold sync, included here for completeness if results/QC context is ever needed.

---

## `U_DDIHOLDLIST` — full column reference

The hold event table. One row per hold placed on a submission.

| Column | Type | Notes |
|---|---|---|
| `U_DDIHOLDLISTID` | VARCHAR2(20), NOT NULL | Primary key |
| `DDIHOLDLISTDESC` | VARCHAR2(80) | **Confirmed: exact duplicate of `U_HOLDCODE`** on every sampled row. Redundant for this use case — don't bother reading it in the sync. |
| `USERSEQUENCE` | NUMBER | Not yet characterized |
| `CREATEDT` | DATE | **Hold creation timestamp — always populated** |
| `CREATEBY` | VARCHAR2(20) | Who/what created the hold (see CREATETOOL note below) |
| `CREATETOOL` | VARCHAR2(20) | **Not just humans** — seen values include `Data Entry v18_99G` (UI entry), `Numbering v5.40` (automated), `HL7FileMover` (automated). Worth carrying into the ticket so CS can distinguish human vs. system-placed holds. |
| `MODDT` | DATE | **Confirmed unreliable/unused** — stays NULL even when a hold is fully resolved (`U_OUTDATE`/`U_HOLDRELEASEDBY` populated). Do not use as a general "last touched" watermark. |
| `MODBY` | VARCHAR2(20) | Same caveat as `MODDT` — not populated in observed data |
| `MODTOOL` | VARCHAR2(20) | Not yet characterized (likely also unused, given MODDT/MODBY pattern) |
| `AUDITSEQUENCE` | NUMBER | Not yet characterized |
| `AUDITDEFERFLAG` | VARCHAR2(1) | Not yet characterized |
| `TRACELOGID` | VARCHAR2(20) | Not yet characterized — possibly links to a separate trace/audit table |
| `NOTES` | VARCHAR2(2000) | Free text. **Confirmed blank on every row in a 20-row sample.** Plan for "usually empty" rather than assuming CS will typically get free-text context — the coded `U_HOLDCODE`/`U_HOLDCODEID` may be the only detail available on most tickets. Worth checking a larger sample before concluding it's *always* unused. |
| `TEMPLATEFLAG` | VARCHAR2(1) | Not yet characterized |
| `U_SUBMISSIONID` | VARCHAR2(20) | **The join key.** Confirmed real FK → `SUBMISSION`. Format like `260908-2221`. |
| `U_SAMPLEID` | VARCHAR2(20) | **Confirmed empty on every sampled row.** Do not rely on this for a Sample-level join — use `U_SUBMISSIONID` instead. |
| `U_DOCTORID` | VARCHAR2(20) | Not yet checked whether reliably populated |
| `U_HOLDCODE` | VARCHAR2(80) | Hold code as display text (e.g. "Verify Test Type") |
| `U_HOLDCODEID` | NUMBER | **Use this as the canonical mapping key, not the text.** Confirmed stable per code across multiple real rows (see mapping table below). Likely FK → `U_HOLDREASON`. |
| `U_HOLDOUTDATE` | VARCHAR2(20) | **Confirmed blank on every sampled row, and wrong type (text) for a date field anyway. Ignore this column.** |
| `U_HOLDRELEASEDBY` | VARCHAR2(20) | Who released the hold — populated together with `U_OUTDATE` |
| `U_OUTDATE` | DATE | **The real resolution timestamp.** NULL while a hold is active, populated on release. |

### Confirmed `U_HOLDCODE` → `U_HOLDCODEID` mappings (from real data, not exhaustive)

| U_HOLDCODEID | U_HOLDCODE (as stored) |
|---|---|
| 1 | Advanced Beneficiary Notice *(note: "Advanced," not "Advance" — crosswalk corrected)* |
| 3 | Credit Card Info Missing/Incorrect |
| 9 | Patient Info. Missing |
| 13 | Prompt Payment vs.List Price |
| 17 | Sample needs to be Cancelled |
| 19 | Verify Billing and/or Price |
| 20 | Verify Doctor and/or Address |
| 21 | Verify Test Type |
| 28 | Missing Patient Age/DOB |
| 29 | No or Questionable Sample Date |
| 30 | No or Incorrect Submittal |
| 43 | LAB Hold |
| 47 | Signf Result:Patient State Missing |

Expect more IDs to exist beyond this list — this is only what's shown up in samples pulled so far. `U_HOLDREASON` (once inspected) should give the full/authoritative list.

### Change-detection query pattern (confirmed necessary)

Because `MODDT`/`MODBY` are unreliable, catching both new and newly-resolved holds requires checking two columns:

```sql
WHERE CREATEDT > :last_watermark OR U_OUTDATE > :last_watermark
```

---

## `U_DDICUSTOMERHOLD` — column reference (**confirmed: this is a VIEW, not a table**)

Confirmed via `all_views`. Its defining query starts `SELECT U_DDIHOLDLIST.U_SUBMISSIONID, U_DDIHOLDLIST.U_HOLDCODE, U_DDIHOLDLIST.CREATEDT...` — **it's built directly on top of `U_DDIHOLDLIST`**, not a separate data source. This means there is no second hold-tracking system to reconcile against — it's the same underlying data, joined with doctor/patient name fields and price/billing info, almost certainly filtered to a specific subset of hold codes.

Full `WHERE`/filter clause not yet retrieved (SQL*Plus truncated the `TEXT` column by default). Get the complete definition with:
```sql
SET LONG 100000
SET PAGESIZE 0
SET LINESIZE 200
SELECT DBMS_METADATA.GET_DDL('VIEW','U_DDICUSTOMERHOLD','SAPPHIRE') FROM dual;
```
**This is the single highest-value next query for the Billing/CS routing question.** If the filter is on specific `U_HOLDCODEID`/`U_HOLDCODE` values matching the Billing-only codes named in the Problem Log doc (Medicare, PECOS, Credit Hold, ABN), that's a database-confirmed routing list — no longer an inference from Copia's UI category labels.

| Column | Type |
|---|---|
| `U_SUBMISSIONID` | VARCHAR2(20) |
| `U_HOLDCODE` | VARCHAR2(80) |
| `CREATEDT` | DATE |
| `U_DOCTORID` | VARCHAR2(20) |
| `LASTNAME` | VARCHAR2(80) |
| `FIRSTNAME` | VARCHAR2(80) |
| `U_PRICE` | NUMBER |
| `U_TEMPLATEID` | VARCHAR2(20) |
| `U_BILLING` | VARCHAR2(20) |
| `PTLASTNAME` | VARCHAR2(80) |
| `PTFIRSTNAME` | VARCHAR2(80) |

---

## Confirmed relationships

| From | Column | To | How confirmed |
|---|---|---|---|
| `U_DDIHOLDLIST` | `U_SUBMISSIONID` | `SUBMISSION` | Real DB-declared foreign key constraint |

**Relationships from the earlier MS Access diagram (not yet independently re-confirmed against real Oracle constraints in this session):**
- `SUBMISSION` → `U_DOCTOR` (1:1)
- `SUBMISSION` → `U_PATIENT` (1:1)
- `SUBMISSION` → `SAMPLE` (1:many)
- `SAMPLE` → `U_BLOODSAMPLE` / `U_FECALSAMPLE` / `U_HAIRSAMPLE` / `U_URINESAMPLE` / `U_WATERSAMPLE` (1:many each, by sample type)
- `SAMPLE` → `SDIDATA` → `SDIDATAAPPROVAL` / `SDIDATAITEM` (results data)

**Note on relationship discovery method:** a query against `all_constraints`/`all_cons_columns` for formal foreign keys on the hold tables returned only the one relationship above. It's possible (given the earlier finding that business logic lives in the application tier, not the database) that many other relationships in this schema are **not** declared as real FK constraints — just implied by matching column names that application code joins on. When a formal-constraint search comes back empty, fall back to searching `all_tab_columns` for shared column names (e.g. `U_SUBMISSIONID`, `U_DOCTORID`) across tables, the same way `U_DDIHOLDLIST` and `U_HOLDREASON` were originally found.

---

## `U_HOLDREASON` — full master hold-code list (39 codes, confirmed)

| ID | Hold Reason |
|---|---|
| 1 | Advanced Beneficiary Notice |
| 3 | Credit Card Info Missing/Incorrect |
| 4 | Diagnosis Code |
| 5 | Hrs Collected not marked |
| 6 | Insurance Info. Missing |
| 7 | More than one sample received |
| 8 | Doctor Info. Missing |
| 9 | Patient Info. Missing |
| 10 | No Serum received |
| 12 | No/Questionable Volume |
| 13 | Prompt Payment vs.List Price |
| 15 | Patient Name not match |
| 17 | Sample needs to be Cancelled |
| 19 | Verify Billing and/or Price |
| 20 | Verify Doctor and/or Address |
| 21 | Verify Test Type |
| 22 | Sample does not Match test ordered |
| 24 | Declined Credit Card |
| 25 | Medicare Questions (not ABN) |
| 26 | No Sample Received |
| 27 | Single Element/Add-on Element |
| 28 | Missing Patient Age/DOB |
| 29 | No or Questionable Sample Date |
| 30 | No or Incorrect Submittal |
| 31 | Hair Sample Mixed |
| 32 | Verify Urine Iodide Dosage |
| 33 | QUICK FIX |
| 34 | SOILED/DAMAGED CHECK |
| 35 | GRACE |
| 36 | NY CANCEL |
| 37 | Iodine Volume Hold |
| 38 | Expired Vial |
| 40 | Consent Signature |
| 41 | PECOS |
| 43 | LAB Hold |
| 44 | Foreign Subaccount |
| 45 | Credit Hold |
| 46 | Questionable Payment Amount |
| 47 | Signf Result:Patient State Missing |

Gaps in numbering (2, 11, 14, 16, 18, 23, 39, 42) — likely retired/unused IDs, not a data quality problem. **This is now the authoritative source for the crosswalk's Sapphire side** — update `Hold_Code_Crosswalk_DRAFT.xlsx` against this list rather than the original work-instruction document.

Notable: codes 38, 40, and 47 show `CREATETOOL = MS-Access` / `msaccess` rather than `LVX` — confirms this reference table gets edited directly via Microsoft Access by someone (`bgubbins` added code 47 in Oct 2025), bypassing the application tier. Worth knowing `bgubbins` as a named contact — possibly the same person (or connected to) who built the earlier MS Access relationship diagrams.

---

## Join strategy — recommendation update

**Don't link the Case to `Sample__c`.** Confirmed `SAMPLE.U_SUBMISSIONID` shows a submission can have multiple samples — meaning a hold on a submission wouldn't have a single unambiguous `Sample__c` to attach to.

**Instead, link directly to Account and Contact, reusing the existing sync's exact join keys:**
- **Account:** `U_DDIHOLDLIST.U_DOCTORID` (confirmed reliably populated — 99.4% of rows) matches `Account.Name` directly. **No join needed at all.**
- **Contact:** `SUBMISSION.U_SUBACCOUNTID` matches `Contact.SubAccountId__c`. Needs one join: `U_DDIHOLDLIST.U_SUBMISSIONID → SUBMISSION.SUBMISSIONID`, then read `U_SUBACCOUNTID`.

This is simpler than the original plan and avoids a genuine ambiguity (which sample?) rather than working around it.

---

## `U_DDICUSTOMERHOLD` — routing hypothesis disproven

```sql
SELECT DISTINCT u_holdcode FROM U_DDICUSTOMERHOLD;
```
returned **25 of the 39 total hold codes** — including clearly CS-only codes (Hair Sample Mixed, LAB Hold, Verify Test Type) sitting alongside Billing-specific ones (Credit Hold, ABN, PECOS). **This rules out the Billing/CS-split hypothesis.** If it were a Billing filter, codes like "Hair Sample Mixed" would never appear.

Excluded codes (14): Hrs Collected not marked, No Serum received, Sample needs to be Cancelled, Sample does not Match test ordered, Medicare Questions (not ABN), No Sample Received, Verify Urine Iodide Dosage, QUICK FIX, SOILED/DAMAGED CHECK, GRACE, NY CANCEL, Expired Vial, Consent Signature, Foreign Subaccount. No clean unifying theme — likely reflects whatever was relevant to a specific report this view was originally built for, not a maintained routing rule.

**Conclusion: the database does not answer the Billing-vs-CS routing question.** This needs to come directly from whoever owns the CS/Billing process (already on the outreach list in the Scoping Notes doc) — not inferable from schema.

1. **Billing-vs-CS routing needs a direct business answer** — the database hypothesis (`U_DDICUSTOMERHOLD`) is disproven, see above. Route this through the CS/Billing outreach already planned in the Scoping Notes doc.
2. **What do `SUBMISSION_CHANGE_LOG` / `SAMPLE_CHANGE_LOG` / `U_DOCTOR_CHANGE_LOG` contain?** Possible alternate/supplementary source for change detection if `CREATEDT`/`U_OUTDATE` on the hold table ever prove insufficient.
3. **What are `A_U_DOCTOR`, `U_PATIENTLOG`, `U_PATIENTREG`, `U_OTHERSAMPLE` for?** Not yet inspected — lower priority unless they turn out relevant.

**Resolved this round:** `Sample__c` join question — resolved by *avoiding* the join entirely (see join strategy above) rather than answering it directly, since linking through Account/Contact sidesteps the multi-sample-per-submission ambiguity altogether.
