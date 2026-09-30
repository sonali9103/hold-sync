# Scoping Notes: Copia / Sapphire Hold → Salesforce Ticket Sync

## Decisions locked in

- **Harvest is out of scope for now.** Everything below applies to Copia and Sapphire only.
- **V1 is Sapphire holds only. Copia comes later, as its own phase.** Sapphire already has a working REST integration to build from; Copia's access model is still an open vendor/internal question that no longer blocks v1. This also means the Copia access email in this conversation can go out in parallel, at a lower priority, without holding up any actual build work.
- **Cancelations stay in the same ticket lifecycle as holds**, not a separate object/process. Accessioning (not CS) performs the cancelation in Sapphire/Copia; the sync detects it and the ticket's status updates to **Cancelled**, and the ticket closes — CS doesn't have to manually resolve it.
- **Multiple hold codes on one Lab ID = one parent ticket with sub-tickets underneath**, one sub-ticket per hold code. The parent can only move to Resolved once every sub-ticket under it is resolved.
- **v1 is a single daily batch — STAT holds included.** No event trigger or shorter interval needed for v1. This is a deliberate tradeoff, not an oversight: a STAT hold placed just after a run completes could sit unseen by CS for up to ~24 hours until the next run. Worth naming explicitly to whoever signs off on this, since STAT holds are the one hold type the source docs call out as time-sensitive. Once the daily pipeline exists, adding a faster/separate run just for STAT is a much smaller lift than building event-driven sync from scratch — treat this as a known phase-2 candidate rather than a closed question.

**One design note worth keeping even though Copia is deferred:** still build the sub-ticket's Hold Type field against the *canonical* picklist from the crosswalk (not raw Sapphire codes), even though only Sapphire feeds it in v1. That avoids a rename/migration on the picklist itself when Copia gets added later — you'd just be adding new source-code mappings into an already-canonical field, not restructuring it.

These resolve the biggest open questions from the first pass. See the updated data model and the two new open questions below (both stem directly from the cancelation/sub-ticket decisions).

## Roadmap

- **v1.0** — Sapphire → SF ticket sync, one-way, CS holds only, manual run
- **v1.1** — add Copia to the read side, still manual run
- **v1.2** — SF → Sapphire write-back (case resolution), still manual trigger
- **v1.3** — SF → Copia write-back, still manual trigger
- **v2.0** — automate the full pipeline (cron/Temporal), only after v1.0-v1.3 are each individually correct — deliberately not bundled with v1.1's Copia work, since scope breadth and operational maturity are separate axes of risk

## Findings from the Temporal repo audit

An investigation of the actual `temporalsalesforce` codebase (not assumptions) turned up two things that change scope materially:

- **No Copia connectivity exists anywhere in the repo.** The entire sync is Sapphire-only, reached via plain REST calls with no auth headers (access is controlled by internal-network placement, not credentials). If Copia needs to feed this pipeline, there is nothing here to extend — Copia access (API vs. DB-only vs. something else) needs its own ground-up investigation.
- **No write-back to any source system exists, in either direction.** The current sync only ever writes into Salesforce. The bidirectional requirement from the Problem Log doc (closing a ticket releases the hold back in Sapphire/Copia) is entirely new work, not an extension of existing code.

Other things confirmed by the audit that affect design choices below:

- Change detection is "now minus 24 hours" on every run, with no persisted watermark — it relies on natural-key matching to tolerate the daily overlap. A missed run beyond 24 hours can silently drop changes, recoverable only via manual backfill.
- Dedup is SOQL-lookup-by-natural-key + create/update by record ID, not Salesforce's atomic `upsert()` — the repo itself flags a race condition where overlapping runs can double-create records.
- Production runs via manual CLI trigger around 2:30 PM daily; the Temporal Schedule defined in code is not what's actually driving production.
- Salesforce auth is session-based username/password (not a Named Credential, despite Connected-App-shaped config variables); secrets live in a plaintext `.env` on the server with no vault.
- Sapphire is confirmed to be a database underneath — the existing sync reaches it through a REST layer (`/v2/doctor`, `/v1/sales`), but a direct DB read connection is a separate, live option worth asking about for new integration work.
- **`Sample__c` already exists in Salesforce, keyed by Lab ID (Sapphire's SampleId), with Account and Contact already linked to it.** If a hold record carries the same Lab ID, a new hold ticket can join directly to the existing `Sample__c` record for its Account/Contact links, instead of re-deriving the DoctorId/SubaccountId join independently.

### What's understood about the two systems day-to-day (not yet from documentation)

- **Sapphire** is a database, and also where other lab departments enter order-related information — consistent with it being the backing store the REST sync already reads from.
- **Copia** appears to be a web-based order-placing portal. Not yet confirmed whether it's vendor-hosted or built/administered internally, and the person scoping this project doesn't have personal access to it — so the first Copia question isn't technical, it's organizational: who administers it, and is it a vendor relationship or an internal system? That determines whether "get Copia access" is an internal ticket or a vendor conversation with its own timeline.

## Findings from internal system diagrams (Copia/Sapphire architecture, Oracle schemas, existing queries)

A set of internal architecture diagrams and Oracle schema screenshots surfaced several findings that materially update the picture above — some confirm assumptions, two overturn them.

**Copia may not be a black box after all.** One diagram is an MS Access relationship view built directly against Copia's own database tables (`copia_Requisition`, `copia_OrderedPanel`, `copia_Result`, `copia_ResultComment`) — the same tool and pattern used for the equivalent Sapphire Oracle diagram. Someone already has a working database connection into Copia's backend to have produced this. **Revise the earlier "Copia = vendor portal, unclear access" framing** — the first Copia question is now "who built this diagram, and can I get the same access they already have," not "does an API exist at all."

**Copia and Sapphire may be split by test type, not duplicate paths for the same orders.** The conceptual architecture diagram labels one side "stool tests" (routed through Harvest/Copia) and the other "non-stool tests" (routed through Sapphire). If this split is real and consistent, **v1 (Sapphire-only) only covers non-stool-test holds** — stool-test holds live in Copia and are invisible until phase 2. Confirm this explicitly, and find out roughly what share of hold volume falls on each side — it affects how much v1 actually buys you.

**Sapphire receives stub records for Copia cancellations, but not for in-process Copia holds.** A Venn diagram of two existing queries ("4001 Sapphire query" / "4000 Copia query") states directly: *"we create stub/virtual records for Completed/Cancelled Copia orders in Sapphire... You never need to query Copia for Cancelled or Completed... But to get 'In Process' you need to query both."* Implications:
- Sapphire alone may be enough to detect **Copia-originated cancellations** — worth checking whether that stub record carries enough detail (cancel reason, timestamp) to drive the cancelation-ticket logic in §4, without needing Copia access at all for that piece.
- Copia's **active/in-process holds are not visible in Sapphire under any circumstance** — the stub only appears once the order reaches a final state. This confirms Copia access is still required for actual hold visibility on the Copia side; the stub mechanism only helps with cancellations, not holds.

**There are existing people and artifacts to go straight to, rather than starting from zero.** The same Venn diagram references two named, already-built queries spanning both systems ("4001 Sapphire query," "4000 Copia query") and mentions a colleague, "Jeff," who has his own separate query and a working JSON result service (structured DTOs resembling Data Innovations' contract types). Whoever authored these diagrams, plus Jeff, are concrete people who already have some form of working access/queries against both systems — worth talking to directly instead of re-discovering this from scratch.

**Schema-level detail, with one open gap in both systems:**
- Sapphire: `SAPPHIRE_SAMPLE.U_CANCELREASON` is a direct column — cancellation reason is structured, not free text to parse. No hold-specific table is visible in the diagram reviewed, though — the hold/problem-log table isn't shown, so it likely lives elsewhere in the schema.
- Copia: `copia_Requisition` has `isCancelled`, `canceledModifiedByStaffKey`, `cancelledStamp` (a real cancellation audit trail) plus `updateStamp`/`updateVersion` — a strong candidate for change-detection timestamps once Copia access exists. Same gap as Sapphire: no hold-specific table is visible in this diagram either.
- **Open question for both systems:** where does hold/problem-log data actually live in the schema? Neither reviewed diagram shows it directly — it may be encoded in a status field (e.g., Sapphire's `U_STATUS`, Copia's `requisitionStatus`) rather than a dedicated table, or it may live in a table outside what these diagrams happened to capture.
- Both systems have separate **production and sandbox** Oracle databases — build and test against sandbox, and request that access explicitly rather than defaulting to production.

## Findings from the Sapphire API doc and live LV Explorer access

You now have access to Sapphire's LV Explorer client, and this resolves the top open item from the previous section.

**The `api.doc` found in the installation folder is LabVantage's official 2001-era Sapphire API — but it's the wrong kind of API for this project.** It's a PowerBuilder SDK (requires PowerBuilder 7+ and a special license key) for building custom screens *inside* the LVX desktop client — Page Type, Service, and Action object classes — not a data-access API for pulling records into an external system. Useful for architecture context, not for building the sync itself. It does confirm one thing worth remembering for the write-back design: Sapphire is a strict three-tier system (Client/LVX → Application/SPM → Database), and the client tier never talks to the database directly. Writing straight to Oracle tables — the path suggested by the earlier MS Access relationship diagrams — bypasses whatever validation/business logic lives in the application tier, which reinforces the earlier caution about raw DB writes for the resolution/write-back path.

**LV Explorer's "Problem Log" module already has purpose-built hold reports — this is the real find.** The navigation tree includes: Hold Pending Records, Records On Hold, LAB_HOLD, Holdreason List, Hold Reason Talley, Hold Subm Info, Holded Account, Doctorsonhold, Submission Changelog, Sample Changelog, Released by DateTime. These aren't things to build — they already exist and are actively used.

**The "Records On Hold" report output answers the core schema question directly.** Its columns are `SUBMISSIONID`, `U_TEMPLATEID`, `U_HOLDCODE`, `U_OUTDATE`, `CREATEDT`, `CREATEBY`:
- `SUBMISSIONID` — matches `SAPPHIRE_SUBMISSION` from the earlier Oracle relationship diagram, and is very likely the same identifier used elsewhere as the Lab ID. This is your join key.
- `CREATEDT` / `CREATEBY` — a real creation timestamp and the person who placed the hold. **This answers the change-detection timestamp question** that's been open since the first pass of this document.
- `U_OUTDATE` — almost certainly populated on hold release, making it the likely signal for detecting a resolved hold without needing a separate lookup.
- `U_HOLDCODE` — literal text ("Verify Test Type," "Patient Info. Missing," "Credit Card Info Missing/Incorrect," "Missing Patient Age/DOB," etc.) that lines up closely with the crosswalk draft built earlier — good real-world validation of that work.

**Table confirmed via direct Oracle query: `U_DDIHOLDLIST`.** Its full schema exceeds what the report showed, and several fields materially improve the sync design:
- `MODDT` / `MODBY` — a genuine last-modified timestamp+editor, better than `CREATEDT` alone as a watermark since it catches updates, not just new records.
- `U_HOLDRELEASEDBY` — who released the hold, for the sub-ticket's resolution audit trail.
- `U_HOLDCODEID` (NUMBER) — likely a foreign key to a master hold-code table (probably backing the "Holdreason List" report) — worth locating, since it may give a cleaner canonical source for the crosswalk than the work-instruction docs.
- `U_SAMPLEID` — a second identifier below `U_SUBMISSIONID`. If it matches `Sample__c.Name` format directly, that's a 1:1 join with no extra hop needed.
- `NOTES` — free text alongside the coded `U_HOLDCODE`.
- Two date-shaped fields need disambiguating: `U_OUTDATE` (real `DATE` type, likely the resolution timestamp) vs. `U_HOLDOUTDATE` (`VARCHAR2(20)`, possibly just a formatted display copy — confirm before relying on either).

**A second table, `U_DDICUSTOMERHOLD`, was investigated as a possible database-level answer to Billing-vs-CS routing — ruled out.** It's actually a view over `U_DDIHOLDLIST`, and its code list (25 of 39 total codes, including clearly CS-only ones like Hair Sample Mixed and LAB Hold) doesn't correspond to a Billing/CS split — see the Sapphire Database Knowledge doc for the full finding. **Routing still needs to come directly from whoever owns the CS/Billing process**, same as the item below.

**Confirmed from live production data (20-row sample):**
- **`U_HOLDCODEID` is a stable numeric ID per hold code** — e.g., "Missing Patient Age/DOB" = 28, "Verify Doctor and/or Address" = 20, "Credit Card Info Missing/Incorrect" = 3, "Advanced Beneficiary Notice" = 1 (note the correct spelling — "Advanced," not "Advance," as the crosswalk had it), "LAB Hold" = 43, "Sample needs to be Cancelled" = 17. **Use this numeric ID as the canonical mapping key, not the text**, which is more reliable against drift/typos.
- **Holds aren't only placed by humans.** `CREATETOOL` shows both UI-based entry ("Data Entry v18_99G") and automated processes ("Numbering v5.40," "HL7FileMover") placing holds on their own. Worth carrying `CREATETOOL` into the ticket data so CS can distinguish human-placed from system-generated holds.
- **Real production proof of multi-hold-per-submission**, validating the sub-ticket design directly: submission `260908-2057` carries two simultaneous holds ("LAB Hold" and "Sample needs to be Cancelled"), and the printed report separately showed three more submissions each with two different hold codes. This isn't a theoretical edge case — it shows up repeatedly in small samples.
- **Previously-uncertain codes confirmed active in production:** "Single Element/Add-on Element" and "Hair Sample Mixed," both flagged as possibly legacy/unused in the earlier crosswalk draft, appear in current real records.

**Confirmed via a clean pipe-delimited query (resolves two more open items):**
- **`U_SAMPLEID` is empty on every sampled row.** The earlier hope of a direct join to `Sample__c` via a matching sample ID doesn't hold — **`U_SUBMISSIONID` is the real join key** (format like `260908-2221`). New open question this raises: does `Sample__c.Name` in the existing sync actually get populated from Sapphire's SubmissionId, or from a separate SampleId on `SAPPHIRE_SAMPLE` (a distinct table per the earlier Oracle relationship diagram)? If the latter, an extra join hop (submission → sample) is needed — confirm before assuming a clean 1:1 link.
- **`MODDT`/`MODBY` are never populated, even on release.** A row with `U_OUTDATE` and `U_HOLDRELEASEDBY` both filled in (hold resolved) still shows blank `MODDT`/`MODBY`. These fields aren't a general "last touched" timestamp in practice. **Change detection needs to check both `CREATEDT` and `U_OUTDATE`** (e.g. `WHERE CREATEDT > :watermark OR U_OUTDATE > :watermark`) to catch both new holds and newly-resolved ones.
- **`U_HOLDOUTDATE` is blank on every sampled row** — combined with it being `VARCHAR2` vs. `U_OUTDATE`'s real `DATE` type, safe to ignore `U_HOLDOUTDATE` entirely and use `U_OUTDATE` as the sole resolution-timestamp field.
- Real example of coordinated resolution: submission `260908-2057`'s two holds (LAB Hold + Sample needs to be Cancelled) both resolved same day by the same releaser (Ahernand) — useful test case for the parent/sub-ticket resolution logic.

**Still open:** the identity of the master hold-code table (behind `U_HOLDCODEID`), confirmation that `U_DDICUSTOMERHOLD` is really the Billing split, and the `Sample__c.Name` join-key question above.

## 1. The core problem: this isn't the same shape as the Temporal account/contact/doctor sync

Your existing Temporal job is (presumably) **one-way, daily, read-only**: pull account/contact/doctor changes from the source system(s), upsert into SF.

The workflow docs describe one more requirement layered on:

- **Bidirectional sync, not one-way.** From the Problem Log workflow doc:
  > "notes placed into SF need to transfer to the appropriate database (Copia and/or Sapphire) — and vice versa"
  > "Closing a completed ticket in SF should release the hold in Sapphire/Copia — and vice versa."

  That means you need **write access** into Copia/Sapphire, not just read access. That's a different integration pattern, different risk profile, and probably a different approval process than a read-only nightly pull. This is the one piece of the existing sync's shape that doesn't carry over — everything else (cadence, batch structure) can.

- Note the doc's own language suggests the eventual end state is event-driven ("The act of canceling a test should automatically trigger a new ticket in SF"), and STAT holds are explicitly called time-sensitive — but per the decision above, v1 is deliberately choosing daily batch for everything including STAT, with faster STAT handling deferred to a later phase rather than blocking v1.

## 2. Copia and Sapphire have different hold data models — you need a crosswalk

| System | How a hold is entered | Structure |
|---|---|---|
| **Sapphire** | Data Entry → "Open Problem Log/Hold" → check boxes for each applicable hold code → Save x2 | Flat list of ~39 checkbox hold codes per Lab ID. **Multiple codes can be checked at once on one record** — this is explicitly flagged as unresolved in the doc: *"We should determine if multiple hold codes will result in multiple tickets or if we can have one ticket per lab ID regardless of the number of holds/issues."* That's a business decision you need before you design the SF ticket schema. |
| **Copia** | Order Choice Search → type "Hold" → select hold type → Clinical Info → free-text reason → Save | Organized into 5 *categories* (Hold Doctor/Patient, Hold Test/Specimen, Hold Billing, Hold Medicare, Hold STAT), each with several specific reasons, plus a **free-text reason field** on top of the selected code. |
The Hold Codes spreadsheet is **not a crosswalk** — it's two separate lists sitting side by side (Sapphire's flat list in column A, Copia's five category-headers with their sub-codes in columns C/E/G/I/K). There's no explicit mapping saying "Sapphire's 'Credit card Missing/Incorrect' = Copia's 'Missing or Unacceptable Credit Card Info.'" Someone who knows both systems needs to build that crosswalk — it's the single most important artifact for this project, because your SF ticket needs one canonical "Hold Type" picklist (used on the sub-ticket, per §5) that both systems' codes map into.

**For v1 (Sapphire only):** only the Sapphire side of the crosswalk needs SME validation right now — the Copia column can stay as a draft for phase 2. Build the canonical picklist itself now anyway (see the decision note above), so Copia's codes slot into an existing structure later rather than triggering a picklist redesign.

## 3. Two categories that must route differently

The Problem Log doc splits holds into:

- **Billing Holds** (Medicare, PECOS, Credit Hold, ABN) — handled by Billing, not CS
- **Customer Service holds** — all other codes, handled in CS
- **STAT hold** — Copia only, time-sensitive, blocks lab processing

Your ticket sync needs a hold-code → queue mapping so tickets land with the right team automatically, not a single undifferentiated CS queue. This mapping depends on the crosswalk in #2.

## 4. Cancelations are folded into the same ticket lifecycle — two new things to resolve

Cancelations are in scope, sharing the hold ticket pipeline. Two things this raises, directly from the source docs:

- **Full cancelation vs. downgrade.** The Cancelation Workflow doc distinguishes a **full cancelation** (entire test) from a **downgrade** (partial — "white vial qns"). Under the sub-ticket model in §5 below, a full cancelation should plausibly close the *entire parent ticket* (nothing left to test, so no hold reason still matters). A downgrade likely should only resolve/cancel the *specific sub-ticket* tied to the affected element, leaving the rest of the parent ticket's sub-tickets open. Confirm this mapping with whoever owns the cancelation process — it determines whether "cancel" always means "close the whole ticket" or sometimes means "close one sub-ticket."

- **Auto-close vs. the CS letter-processing step.** The Cancelation Workflow doc's current process doesn't end when Sapphire/Copia shows a cancelation code — it ends after CS generates the cancelation letter (Sapphire: overnight Oracle report → PDF → Urgent Message portal; Copia: manual letter generation → shared folder → CS uploads), and *then* the ticket closes. If the sync auto-closes the ticket the moment it sees the cancelation code in the source system, CS loses the ticket as a way to track "letter still needs to go out." Worth confirming whether: (a) letter-sending is being handled/automated separately going forward, (b) it becomes its own sub-ticket/task that must also be resolved before the parent auto-closes, or (c) the auto-close is intentional and letter tracking moves elsewhere.

## 5. Ticket data model implied by these decisions

Reasonable shape, worth validating with whoever owns the SF org before building:

- **Parent ticket** — one per Lab ID event. Likely fits the standard **Case** object (gives you built-in queues, assignment rules, status tracking for free) rather than a fully custom object. Fields: Lab ID, Source System, Status (New / In Progress / Cancelled / Resolved), Queue (CS vs. Billing, per §3), Account/Contact/Doctor lookups (joined via whatever key the existing sync already uses).
- **Sub-ticket** — a custom child object, one per hold code detected on that Lab ID, lookup to the parent Case. Fields: Hold Code (canonical, from the crosswalk in §2), Hold Reason (free text from source system), Status (Open/Resolved), Resolved By, Resolved Date.
- **Closure rule** — a validation rule or Flow on the parent: it cannot move to Resolved while any child sub-ticket is still Open. This is the mechanism that enforces "only after all sub-parts are resolved can the overall ticket be resolved."
- **Cancelation path** — a Flow/trigger that runs off the sync: on detecting a cancelation code for a Lab ID that already has an open parent ticket, set the parent Status to Cancelled and closed (see §4 for the full-vs-downgrade nuance — a downgrade may need to target one sub-ticket instead of the parent). On detecting a cancelation code with no existing parent ticket (a cancelation with no prior hold), create a new ticket directly in a cancelation-tracking state, subject to the open question in §4 about whether letter-processing keeps it open.

## 6. Questions to answer before writing any code

**About the source systems (get someone who actually uses Copia/Sapphire for these — don't guess):**
- **Copia access, from scratch.** The Temporal repo confirms there's no existing Copia connection to inspect. Someone needs to find out directly: does Copia expose an API, is it DB-only, or something else entirely? This now blocks everything else on the Copia side.
- Is there a timestamp/audit field on hold placement (created date, modified date, modified by) in each system? Sapphire's existing sync doesn't rely on one (it just uses "now minus 24 hours"), so this needs a fresh check specifically for the hold/problem-log data, not an assumption that the same approach is available.
- Is there a dedicated hold/problem-log **table** you can query directly, or via the same kind of REST endpoint Sapphire already exposes for doctors/samples?
- Does releasing a hold, or canceling a test, in the source system leave a record of *when* and *by whom*, or does it just flip a flag with history lost? You need this to distinguish "hold resolved" from "test cancelled" reliably.
- What's the reliable join key back to the Account/Contact records already in SF? The existing sync uses Account.Name ← Sapphire DoctorId and Contact.SubAccountId__c ← Sapphire SubaccountId — confirm whether Lab ID/hold records carry either of these, or need a different join entirely.

**About write-back:**
- Confirmed: there is no existing write path back into Sapphire or Copia to build from — this is net-new. What should happen in the source system when a sub-ticket is resolved — clear that specific hold flag? Require a resolution code? Is there a write-capable API, or would this mean touching production tables directly (much higher risk, needs real change control)?
- What happens if accessioning or a lab tech clears a hold directly in Copia/Sapphire *before* CS resolves the corresponding sub-ticket? You need reconciliation logic so sub-tickets don't go stale/orphaned.

**Business decisions, not technical ones:**
- The full-cancelation-vs-downgrade scope question and the letter-processing/auto-close question, both in §4.
- ~~Who are "JW/KA/Others"~~ — **KA is the CS Manager.** For v1, every Case (both CS and Billing hold types) assigns to KA directly, since Billing has no Salesforce accounts yet. Queue__c is still set correctly for future use, just not driving assignment yet.

**Data sensitivity:**
- Hold reasons routinely reference credit card info, insurance info, DOB, Medicare status — this is PHI/PCI-adjacent data landing in SF ticket fields. Worth a quick compliance check on what's allowed to sync verbatim (e.g., "credit card declined" is fine; a card number is not) before you design the field-level mapping.

## 7. What you can genuinely reuse from the Temporal project — revised after the repo audit

Less than the general pattern-matching in §6 suggested. Concretely:

- **Reusable (Sapphire side only):** the base URL/port config pattern, the `SapphireClient` construction approach in the activity layer, and the overall fetch → transform → Salesforce-activity → notification workflow shape. Note `SapphireClient` has hardcoded per-endpoint methods, not a generic authenticated request helper — a hold-ticket feed needs its own new client method, DTO, activity, and workflow, following the existing shape rather than literally calling into it.
- **Reusable:** the Temporal worker/task-queue registration pattern, and the Salesforce query/create/update wrapper (jsforce, SObject REST API, 200-record chunking).
- **Not reusable, and worth deliberately doing differently:**
  - The natural-key-lookup dedup pattern — its own known race condition on overlapping runs is a bigger risk for tickets than it apparently was for contacts. Use Salesforce's real `upsert()` with an external ID field for the new hold-ticket and sub-ticket objects instead.
  - The "now minus 24 hours, no persisted watermark" change-detection approach — acceptable risk for contact updates, less so for holds where a missed run means CS never sees an issue. Worth at least a persisted last-successful-run timestamp for this new sync, even if everything else about cadence stays daily.
  - **Nothing for Copia** — there's no existing connection, client, or pattern to build from. Getting Copia access sorted (and understanding whether it looks anything like the REST approach used for Sapphire) is now its own separate, unblocking task.
  - **Nothing for write-back** — the existing sync never writes to a source system. The write path for releasing holds / closing tickets is 100% new design and new code, not an extension.

Also flag while you're in there, independent of this project: there's an untracked `.env.test` with the same secret-variable names as the production `.env`, and it isn't covered by the current `.gitignore` — worth getting that cleaned up as a general hygiene item.

## 9. V1 Kickoff Plan

### Questions to ask, organized by who can actually answer them

**Whoever owns Copia/Sapphire technically (IT or vendor liaison) — confirmed contact: Sara (Salesforce admin), or the LIMS team.** Per `08-integration-reference.md` in the temporalsalesforce repo, she's the named point of contact for anything LIMS/Sapphire-related. Route the questions below to her directly rather than a generic IT request.
- Sapphire questions are the priority now, since v1 is Sapphire-only. Copia questions below can go out at the same time but don't need an answer before you start building.
- For Sapphire: given it's confirmed to be a database, is a direct read connection (ideally a read replica) available for new integration work, or should this go through the same REST layer the existing sync uses? Ask which is actually preferred rather than assuming.
- How can hold data actually be accessed — direct DB, REST/SOAP API? (Already confirmed the existing sync uses REST for doctors/samples — likely the same for holds, but confirm rather than assume.)
- What's the process to request access to a new endpoint or expanded scope — VPN, service account, credentials, firewall rule?
- Does a hold or cancelation record carry a created/modified timestamp I can use for change detection? (Don't assume — the existing Sapphire sync doesn't rely on one; it just uses "now minus 24 hours." This matters even more here since multiple lab departments write into Sapphire — you need a way to isolate an Accessioning hold change from unrelated writes to the same record.)
- Is there any existing write-capable interface — an API endpoint, an import job — I could use to push a resolution back? If not, what would it take to add one?
- **Does a hold/cancelation record carry the same Lab ID / SampleId already used as `Sample__c.Name` in Salesforce?** If yes, that's a ready-made join key — a new hold ticket can link straight to the existing `Sample__c` record (and inherit its Account/Contact) instead of rebuilding the join from scratch.
- *(Lower priority, for phase 2 planning only):* is Copia a vendor product or internally hosted, and who's the technical/vendor contact? — but ask specifically about who built the existing Copia and Sapphire Oracle relationship diagrams first, since that person may already have the access this question is trying to establish.
- Confirm the stool/non-stool test-type split between Copia and Sapphire, and roughly what share of hold volume is on each side — this determines how much v1 (Sapphire-only) actually covers.
- What does a Copia stub record in Sapphire (created on completion/cancellation) actually contain — enough to detect a Copia cancellation, or just enough for billing reconciliation?
- What are the "4001 Sapphire query" and "4000 Copia query" already in use, and can their definitions be reused or extended?
- Loop in Jeff (referenced as already having a JSON result service and his own cross-system query) directly into discovery.
- ~~Where does hold/problem-log data actually live in each schema~~ — **answered for Sapphire.** LV Explorer's "Problem Log" module has purpose-built reports (Hold Pending Records, Records On Hold, LAB_HOLD, Holdreason List, Submission Changelog, Sample Changelog) backed by a real data source with `SUBMISSIONID`, `U_TEMPLATEID`, `U_HOLDCODE`, `U_OUTDATE`, `CREATEDT`, `CREATEBY` columns — see the new findings section below. Still open for Copia.

**Whoever owns the CS/Accessioning process (business):**
- The full-cancelation-vs-downgrade scope question from §4 — does a downgrade close one sub-ticket, or does it not touch the parent ticket's status at all?
- Does auto-closing on cancelation skip the CS letter-processing step from the Cancelation Workflow doc, or should that step become its own required sub-ticket?
- Confirm actual Billing-vs-CS ownership per hold code — Copia's UI category labels ("Hold Billing") don't match the Problem Log doc's explicit list (Medicare/PECOS/Credit Hold/ABN only), so this needs a real answer, not an inference from Copia's screen.
- ~~Who are "JW/KA/Others"~~ — resolved, see above.
- Review and correct the hold-code crosswalk draft (already built — see the crosswalk spreadsheet).

**Whoever owns SF/Temporal infra:**
- Will write-back into production lab systems get sign-off, and what's the approval process for that?
- Preference on Case (standard object) vs. fully custom object for the parent ticket, given you'll want existing queue/assignment-rule functionality?
- Given secrets currently live in a plaintext `.env` with no vault — is this project a reason to introduce one, or should it match existing conventions for consistency (and revisit both later)?
- Can you get environment/repo access to build a new Temporal workflow alongside the existing ones?

### Suggested build sequence for v1 (Sapphire only)

1. **Confirm the Sapphire-side hold data source.** Likely a new endpoint alongside the existing `/v2/doctor` and `/v1/sales` ones. Sit with an SME and look at a live hold record and a live cancelation record; confirm timestamp fields (needed for real change detection, unlike the existing sync's "now minus 24 hours") and confirm whether the record carries the same Lab ID/SampleId used as `Sample__c.Name`, since that's your ready-made join key if so.
2. **Finalize the data model** — the crosswalk already covers Sapphire's codes; get those validated by an SME (Copia's side of the crosswalk can wait). Settle the Billing/CS queue mapping and get the two open business decisions from §4 answered. Design the SF object model: parent Case (or custom object) + child sub-ticket object, external ID fields for real `upsert()`, and the validation rule blocking parent resolution until all children resolve. Use the canonical Hold Type picklist (not raw Sapphire codes) per the note above.
3. **Build the read pipeline.** New Sapphire client method → transform activity (Sapphire code → canonical Hold Type) → Salesforce upsert activity (parent + children) → new Temporal workflow, following the existing fetch→transform→write→notify shape. Use a real persisted watermark rather than inheriting the "now minus 24 hours" pattern. Run it manually alongside the existing manual trigger before touching the schedule.
4. **Add cancelation detection** for Sapphire, mapping to the Cancelled status and closure rules from §4.
5. **Build write-back** — the piece with no existing pattern to extend at all, since the current sync never writes back to Sapphire. Include reconciliation logic for holds released out-of-band (i.e., cleared directly in Sapphire before CS resolves the SF sub-ticket).
6. **Run in parallel with the current manual process** for a stretch before cutover — compare what the sync produces against what CS creates manually, confirm the daily-including-STAT cadence is genuinely acceptable in practice, then decommission the manual step.
7. **Kick off Copia access discovery in parallel, at low priority**, so phase 2 has a head start once v1 is stable — this is where the earlier outreach email comes in, not urgent enough to block anything above.
