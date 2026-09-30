# Hold Sync — Build Requirements Checklist (v1.1 update)

Supersedes the v1.0 sprint checklist for everything below — that doc's schema facts (Section 1-2) and testing notes (Section 7) are still valid and not repeated here. This doc only covers what's changed or been added since v1.0 was completed and tested via `import-from-file.ts`.

---

## What v1.0 already proved working

Confirmed via real end-to-end test (submission `260908-2057`, holds `412835`/`412836`):
- Parsing, grouping (1 parent + 2 sub-tickets), and real `upsert()` by external ID all work correctly.
- Fail-soft Account lookup miss doesn't block the sync.
- Roll-up count and validation rule behave correctly once sub-tickets are Resolved.

**Known limitation surfaced after v1.0 testing, driving the v1.1 changes below:** the Case upsert payload was minimal (Submission Id, Owner, hardcoded Status, Account, Contact only) — no Subject, Description, Department, or Record Type. This is what v1.1 fixes.

---

## v1.1 Salesforce Setup — confirmed done

- [x] Department picklist value `Customer Service` exists on Case
- [x] `Customer Service` is available AND set as the default value specifically for the **CS Ticket Record Type** (not the org-wide default, which is still `Clinical Education` — this is why the test Case showed the wrong Department; `RecordTypeId` was never set on the upsert)
- [x] Case Status, scoped via the CS Ticket Record Type's Support Process ("CS Ticket Process"), trimmed to exactly: **New, Working, Resolved**
- [x] New custom field `Sapphire_Hold_Ids__c` (Text, 255) created on Case — comma-separated list of every `U_DDIHOLDLISTID` under that Case
- [x] `docs/` folder created in the repo with the three reference docs

## v1.1 Salesforce Setup — still to confirm/do

- [ ] Add `Sapphire_Hold_Ids__c` to the CS Ticket page layout (creating a field doesn't auto-add it to any layout)
- [ ] Confirm field-level security on `Sapphire_Hold_Ids__c` for whichever profiles need Case visibility
- [ ] Decide whether to trim the CS Ticket Record Type's Department picklist down to just `Customer Service` (currently still has Billing, Sales Person, Sales Administration available too — not blocking, just loose)
- [ ] Confirm the CS Ticket Record Type's actual API name (referenced as `CS_Ticket` in earlier screenshots) so the code can look it up reliably

---

## v1.1 Code changes — sprint scope

1. [ ] **Set `RecordTypeId` on every Case upsert**, resolved once per run (same pattern as the existing `defaultOwnerId` lookup in `login()`). This is a prerequisite for Department and Status scoping to actually take effect — without it, Cases fall back to the org's default Record Type.

2. [ ] **Fix the sibling-aggregate gap.** `fetchChangedHolds()` only returns rows changed since the watermark — not every hold on an affected submission. Any Case-level aggregate built purely from that subset will drift once a submission gets a second hold in a later run. Fix: for each distinct submission ID returned by `fetchChangedHolds()`, fetch **all** current holds on that submission (reuse `fetchHoldsBySubmissionId()` or extend it) before building the parent aggregate. Applies to `sync.ts`; `import-from-file.ts` may reasonably skip this since it's a fallback/testing tool reflecting only what's in the spooled file.

3. [ ] **Subject** — canonical Hold Type text(s) from the crosswalk, for the full current sibling set (per #2). Multiple distinct types joined with `", "`. Implement as a named, reusable helper.

4. [ ] **`Sapphire_Hold_Ids__c`** — comma-separated list of every `U_DDIHOLDLISTID` currently under the Case, same full-sibling-set logic as #2/#3.

5. [ ] **Department** — explicitly set `Department: 'Customer Service'` in the upsert payload as well, even though the Record Type default should now apply via #1. Don't rely solely on the Salesforce-side default holding for API-created records.

6. [ ] **Description** — map from `NOTES` across the full sibling set, same multi-value approach as Subject. Expect this to often be blank (`NOTES` is usually blank in production data) — that's correct, not a bug.

7. [ ] **Status** — default to `'New'` on Case *creation* only (replacing the old hardcoded `'In Progress'`, no longer valid). Must **not** reset Status back to `'New'` on every re-sync of an existing Case — CS reps' manual Working/Resolved transitions shouldn't get overwritten by the next sync run. Needs a reliable create-vs-update distinction in the upsert flow. Confirm `Block_Resolve_with_Open_Subtickets` validation rule still works unmodified (unchanged spelling of "Resolved").

8. [ ] **Future fields placeholder** — still do not implement doctor/patient name/phone. Leave clearly-marked TODO comments in `transform.ts` and `salesforce-client.ts`. Do not guess `U_DOCTOR`/`U_PATIENT` column names — schema not yet confirmed.

---

## Explicitly deferred past v1.1 (unchanged from v1.0 list)

- Persisted watermark (manual date argument still fine)
- Write-back (releasing a hold from Salesforce)
- Cron/Temporal scheduling
- Security hardening pass (service account scoping, credential storage, PHI-in-logs)
- Doctor/patient name+phone fields (blocked on schema confirmation — see #8 above)

---

## After code changes land

- [ ] Re-run `import-from-file.ts` against the known test case (`260908-2057`) and confirm: Subject, Description, Department, `Sapphire_Hold_Ids__c`, and Status all populate correctly on the Case
- [ ] Test the sibling-gap fix specifically: manually simulate a submission getting a second hold in a later "run" (two separate spooled files for the same submission, run sequentially) and confirm the Case's Subject/`Sapphire_Hold_Ids__c` reflect **both** holds after the second run, not just the second one
- [ ] Test Status create-vs-update: manually set a synced Case's Status to `Working` in Salesforce, then re-run the sync for that same submission — confirm Status stays `Working`, not reset to `New`
- [ ] Update `docs/hold-sync-codebase-reference.md`'s "Open threads" checklist to reflect what's now resolved
