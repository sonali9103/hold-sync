import {
    decideNotesAction,
    fitsSapphireLimit,
    normalizeNotes,
    NotesDecision,
} from './notes-decision';
import {
    NotesSyncCase,
    NotesSyncCaseUpdate,
    SalesforceHoldClient,
} from './services/salesforce-client';
import {
    chunkNotesUpdates,
    SapphireNotesApiClient,
    SapphireNotesClient,
    SapphireNotesOutcome,
    SapphireNotesResult,
    SapphireNotesUpdate,
} from './services/sapphire-notes-client';
import { OracleHoldClient, SubmissionNotesRow } from './services/oracle-client';

export const NOTES_SYNC_USAGE = [
    'Usage: notes-sync [--dry-run|--apply] [--api-dry-run] [--submission <id>|--all-local] [--limit <n>]',
    '  --dry-run          Preview only (default); makes no Salesforce or Sapphire writes.',
    '  --api-dry-run      In dry-run mode, ask Sapphire to validate planned appends.',
    '  --apply            Perform writes; requires --submission or safe --all-local processing.',
    '  --submission <id>  Process one Sapphire submission.',
    '  --all-local        With --apply, process all Cases only if every decision is local-only.',
    '  --limit <n>        Process at most n open Salesforce Cases.',
].join('\n');

export interface NotesSyncOptions {
    apply: boolean;
    apiDryRun: boolean;
    submissionId?: string;
    allLocal?: boolean;
    limit?: number;
    maxWrites?: number;
}

export interface SapphireNotesSource {
    fetchSubmissionNotes(submissionIds: string[]): Promise<SubmissionNotesRow[]>;
}

export interface SalesforceNotesSyncClient {
    getOpenCasesForNotesSync(options: {
        submissionId?: string;
        limit?: number;
    }): Promise<NotesSyncCase[]>;
    updateNotesSyncCase(caseId: string, update: NotesSyncCaseUpdate): Promise<void>;
    addNotesSyncComment(caseId: string, body: string): Promise<void>;
}

export interface NotesSyncLogger {
    log(message: string): void;
}

export interface NotesSyncSubmissionSummary {
    submissionId: string;
    caseCount: number;
    decisions: Array<{ caseId: string; caseNumber: string; action: NotesDecision['action'] }>;
    outcome: string;
    message: string;
}

export interface NotesSyncRunResult {
    submissions: NotesSyncSubmissionSummary[];
    totals: Record<string, number>;
    refused: boolean;
    writeCapReached: boolean;
}

interface CaseDecision {
    caseRecord: NotesSyncCase;
    decision: NotesDecision;
}

interface WritePlan {
    newText: string;
    expectedNotes: string | null;
    appendText: string;
    commentText: string;
}

interface SubmissionPlan {
    submissionId: string;
    cases: NotesSyncCase[];
    decisions: CaseDecision[];
    action: 'noWrite' | 'write' | 'status';
    summaryOutcome: string;
    message: string;
    status?: 'Conflict' | 'TooLong' | 'Error';
    write?: WritePlan;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export function parseNotesSyncOptions(args: string[]): NotesSyncOptions {
    let apply = false;
    let dryRun = false;
    let apiDryRun = false;
    let submissionId: string | undefined;
    let allLocal = false;
    let limit: number | undefined;

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--apply') {
            apply = true;
        } else if (arg === '--dry-run') {
            dryRun = true;
        } else if (arg === '--api-dry-run') {
            apiDryRun = true;
        } else if (arg === '--all-local') {
            allLocal = true;
        } else if (arg === '--submission') {
            const value = args[++index];
            if (!value || value.startsWith('--') || submissionId !== undefined) {
                throw new Error(NOTES_SYNC_USAGE);
            }
            submissionId = value;
        } else if (arg === '--limit') {
            const value = args[++index];
            const parsed = Number(value);
            if (!value || !Number.isSafeInteger(parsed) || parsed <= 0 || limit !== undefined) {
                throw new Error(NOTES_SYNC_USAGE);
            }
            limit = parsed;
        } else {
            throw new Error(NOTES_SYNC_USAGE);
        }
    }

    if (apply && dryRun) throw new Error('--apply and --dry-run cannot be used together.');
    if (apply && apiDryRun) throw new Error('--api-dry-run is only valid in dry-run mode.');
    if (allLocal && !apply) throw new Error('--all-local requires --apply.');
    if (allLocal && submissionId) throw new Error('--all-local cannot be used with --submission.');

    // release-sync requires an explicit target before it can write. Keep the same
    // Dev-only safety posture for this new Sapphire write command.
    if (apply && !submissionId && !allLocal) {
        throw new Error(
            '--apply requires --submission <id> or --all-local while Dev-only safeguards are enabled.'
        );
    }

    return { apply, apiDryRun, submissionId, allLocal, limit };
}

function groupBySubmission(cases: NotesSyncCase[]): {
    groups: Map<string, NotesSyncCase[]>;
    skippedNoSubmissionId: number;
} {
    const groups = new Map<string, NotesSyncCase[]>();
    let skippedNoSubmissionId = 0;
    for (const caseRecord of cases) {
        const submissionId = caseRecord.submissionId?.trim();
        if (!submissionId) {
            skippedNoSubmissionId++;
            continue;
        }
        const group = groups.get(submissionId);
        if (group) group.push(caseRecord);
        else groups.set(submissionId, [caseRecord]);
    }
    return { groups, skippedNoSubmissionId };
}

export function loadedNotesBase(
    base: string | null,
    syncedAt: string | null | undefined
): string | null {
    if (normalizeNotes(base) !== '') return base;
    return syncedAt == null ? null : '';
}

function loadNotesSyncCase(caseRecord: NotesSyncCase): NotesSyncCase {
    return {
        ...caseRecord,
        base: loadedNotesBase(caseRecord.base, caseRecord.syncedAt),
    };
}

function conflictPlan(
    submissionId: string,
    cases: NotesSyncCase[],
    decisions: CaseDecision[],
    message: string
): SubmissionPlan {
    return {
        submissionId,
        cases,
        decisions,
        action: 'status',
        summaryOutcome: 'Conflict',
        message,
        status: 'Conflict',
    };
}

function tooLongPlan(
    submissionId: string,
    cases: NotesSyncCase[],
    decisions: CaseDecision[],
    message: string
): SubmissionPlan {
    return {
        submissionId,
        cases,
        decisions,
        action: 'status',
        summaryOutcome: 'TooLong',
        message,
        status: 'TooLong',
    };
}

function planSubmission(
    submissionId: string,
    cases: NotesSyncCase[],
    rawSapphireNotes: string | null
): SubmissionPlan {
    const orderedCases = [...cases].sort((left, right) => left.caseId.localeCompare(right.caseId));
    const decisions = orderedCases.map((caseRecord) => ({
        caseRecord,
        decision: decideNotesAction({
            sapphire: rawSapphireNotes,
            salesforce: caseRecord.description,
            base: caseRecord.base,
        }),
    }));

    const conflict = decisions.find(({ decision }) => decision.action === 'conflict');
    if (conflict?.decision.action === 'conflict') {
        return conflictPlan(submissionId, orderedCases, decisions, conflict.decision.reason);
    }

    const tooLong = decisions.find(({ decision }) => decision.action === 'tooLong');
    if (tooLong?.decision.action === 'tooLong') {
        return tooLongPlan(
            submissionId,
            orderedCases,
            decisions,
            `Notes are ${tooLong.decision.length} characters and ${tooLong.decision.bytes} UTF-8 bytes.`
        );
    }

    const writeDecisions = decisions.filter(({ decision }) =>
        decision.action === 'push' || decision.action === 'merge'
    );
    if (writeDecisions.length === 0) {
        const action = decisions.length === 1 ? decisions[0].decision.action : 'NoSapphireWrite';
        return {
            submissionId,
            cases: orderedCases,
            decisions,
            action: 'noWrite',
            summaryOutcome: action,
            message: 'No Sapphire append is needed.',
        };
    }

    const normalizedSapphireNotes = normalizeNotes(rawSapphireNotes);
    const additions: string[] = [];
    const seenAdditions = new Set<string>();
    for (const { decision } of writeDecisions) {
        if (decision.action !== 'push' && decision.action !== 'merge') continue;

        // AppendNotes cannot rewrite pre-existing Sapphire text. A merge that
        // changes that prefix (for example, by inserting a separator into it)
        // is not a safe plain append.
        if (!decision.newSapphireNotes.startsWith(decision.expectedSapphireNotes)) {
            return conflictPlan(
                submissionId,
                orderedCases,
                decisions,
                'merged-notes-do-not-preserve-current-sapphire-text'
            );
        }

        const addition = decision.newSapphireNotes.slice(decision.expectedSapphireNotes.length);
        if (addition !== '' && !seenAdditions.has(addition)) {
            additions.push(addition);
            seenAdditions.add(addition);
        }
    }

    let newText = normalizedSapphireNotes;
    for (let index = 0; index < additions.length; index++) {
        const addition = additions[index];
        if (index > 0 && newText !== '' && !addition.startsWith('\n')) newText += '\n';
        newText += addition;
    }

    if (!fitsSapphireLimit(newText)) {
        return tooLongPlan(
            submissionId,
            orderedCases,
            decisions,
            `Merged notes are ${newText.length} characters and ${Buffer.byteLength(newText, 'utf8')} UTF-8 bytes.`
        );
    }

    const appendText = newText.slice(normalizedSapphireNotes.length);
    if (appendText === '') {
        return conflictPlan(submissionId, orderedCases, decisions, 'no-append-text-could-be-derived');
    }

    return {
        submissionId,
        cases: orderedCases,
        decisions,
        action: 'write',
        summaryOutcome: writeDecisions.length === 1
            ? writeDecisions[0].decision.action
            : 'MergedSiblingAppends',
        message: 'Sapphire append is planned.',
        write: {
            newText,
            expectedNotes: rawSapphireNotes,
            appendText,
            // The separator used to join notes is not useful as the visible start
            // of a Case Comment; the comment still contains no prior/base text.
            commentText: appendText.startsWith('\n') ? appendText.slice(1) : appendText,
        },
    };
}

function sapphireOutcomeStatus(outcome: SapphireNotesOutcome):
    | 'Pending'
    | 'Locked'
    | 'TooLong'
    | 'Error' {
    if (outcome === 'Changed') return 'Pending';
    if (outcome === 'Locked') return 'Locked';
    if (outcome === 'TooLong') return 'TooLong';
    return 'Error';
}

export function descriptionUpdateIfChanged(
    caseRecord: NotesSyncCase,
    newDescription: string
): Pick<NotesSyncCaseUpdate, 'description'> {
    return normalizeNotes(caseRecord.description) === normalizeNotes(newDescription)
        ? {}
        : { description: newDescription };
}

function changedNotesUpdate(
    caseRecord: NotesSyncCase,
    update: NotesSyncCaseUpdate
): NotesSyncCaseUpdate | undefined {
    const changed: NotesSyncCaseUpdate = {};
    if (update.description !== undefined &&
        normalizeNotes(caseRecord.description) !== normalizeNotes(update.description)) {
        changed.description = update.description;
    }
    if (update.base !== undefined && caseRecord.base !== update.base) {
        changed.base = update.base;
    }
    if (update.status !== undefined && caseRecord.status !== update.status) {
        changed.status = update.status;
    }
    if (update.message !== undefined && (caseRecord.message ?? null) !== update.message) {
        changed.message = update.message;
    }
    if (update.syncedAt !== undefined) {
        const currentTime = caseRecord.syncedAt == null ? NaN : new Date(caseRecord.syncedAt).getTime();
        if (currentTime !== update.syncedAt.getTime()) changed.syncedAt = update.syncedAt;
    }
    return Object.keys(changed).length === 0 ? undefined : changed;
}

async function updateCaseIfChanged(
    client: SalesforceNotesSyncClient,
    caseRecord: NotesSyncCase,
    update: NotesSyncCaseUpdate
): Promise<void> {
    const changed = changedNotesUpdate(caseRecord, update);
    if (changed) await client.updateNotesSyncCase(caseRecord.caseId, changed);
}

function syncedStatusUpdateIfStale(
    caseRecord: NotesSyncCase,
    now: Date
): Pick<NotesSyncCaseUpdate, 'status' | 'message' | 'syncedAt'> {
    return caseRecord.status === 'Synced'
        ? {}
        : { status: 'Synced', message: null, syncedAt: now };
}

async function updateStatus(
    client: SalesforceNotesSyncClient,
    plan: SubmissionPlan,
    status: 'Conflict' | 'Pending' | 'Locked' | 'TooLong' | 'Error',
    message: string
): Promise<void> {
    for (const caseRecord of plan.cases) {
        await updateCaseIfChanged(client, caseRecord, { status, message });
    }
}

async function applyNoWritePlan(
    client: SalesforceNotesSyncClient,
    plan: SubmissionPlan,
    now: Date
): Promise<void> {
    for (const { caseRecord, decision } of plan.decisions) {
        let update: NotesSyncCaseUpdate | undefined;
        if (decision.action === 'baseline') {
            // This timestamp preserves the fact that an empty base was intentionally
            // synchronized even though Salesforce stores its value as null.
            update = {
                ...(normalizeNotes(caseRecord.description) === ''
                    ? descriptionUpdateIfChanged(caseRecord, decision.newBase)
                    : {}),
                base: decision.newBase,
                syncedAt: now,
            };
        } else if (decision.action === 'setBase') {
            update = {
                base: decision.newBase,
                ...syncedStatusUpdateIfStale(caseRecord, now),
            };
        } else if (decision.action === 'pull') {
            update = {
                ...descriptionUpdateIfChanged(caseRecord, decision.newDescription),
                base: decision.newBase,
                ...syncedStatusUpdateIfStale(caseRecord, now),
            };
        } else if (decision.action === 'noop') {
            update = syncedStatusUpdateIfStale(caseRecord, now);
        }
        if (update) await updateCaseIfChanged(client, caseRecord, update);
    }
}

async function applyUpdatedPlan(
    client: SalesforceNotesSyncClient,
    plan: SubmissionPlan,
    now: Date
): Promise<void> {
    if (!plan.write) throw new Error('Internal error: Updated result without a notes write plan.');

    for (const { caseRecord, decision } of plan.decisions) {
        const shouldSyncDescription = decision.action === 'pull' ||
            decision.action === 'merge' ||
            (decision.action === 'baseline' && normalizeNotes(caseRecord.description) === '');
        await updateCaseIfChanged(client, caseRecord, {
            ...(shouldSyncDescription
                ? descriptionUpdateIfChanged(caseRecord, plan.write.newText)
                : {}),
            base: plan.write.newText,
            status: 'Synced',
            message: null,
            syncedAt: now,
        });
        await client.addNotesSyncComment(caseRecord.caseId, plan.write.commentText);
    }
}

function makeSummary(
    plan: SubmissionPlan,
    outcome: string = plan.summaryOutcome,
    message: string = plan.message
): NotesSyncSubmissionSummary {
    return {
        submissionId: plan.submissionId,
        caseCount: plan.cases.length,
        decisions: plan.decisions.map(({ caseRecord, decision }) => ({
            caseId: caseRecord.caseId,
            caseNumber: caseRecord.caseNumber,
            action: decision.action,
        })),
        outcome,
        message,
    };
}

async function handleSapphireResult(
    client: SalesforceNotesSyncClient,
    plan: SubmissionPlan,
    result: SapphireNotesResult | undefined,
    apply: boolean,
    now: Date
): Promise<NotesSyncSubmissionSummary> {
    if (!result) {
        const message = 'Sapphire returned no result for this submission.';
        if (apply) await updateStatus(client, plan, 'Error', message);
        return makeSummary(plan, 'Error', message);
    }

    const message = result.Message || result.Outcome;
    if (!apply) return makeSummary(plan, result.Outcome, message);

    if (result.Outcome === 'Updated') {
        await applyUpdatedPlan(client, plan, now);
        return makeSummary(plan, 'Updated', message);
    }

    const status = sapphireOutcomeStatus(result.Outcome);
    await updateStatus(client, plan, status, message);
    return makeSummary(plan, result.Outcome, message);
}

function printResult(result: NotesSyncRunResult, logger: NotesSyncLogger): void {
    for (const submission of result.submissions) {
        const decisions = submission.decisions.length === 0
            ? 'not evaluated'
            : submission.decisions
                .map((decision) => `Case ${decision.caseNumber} (${decision.caseId}): ${decision.action}`)
                .join('; ');
        logger.log(
            `Submission ${submission.submissionId} (${submission.caseCount} Case(s); ${decisions}): ` +
            `${submission.outcome} — ${submission.message}`
        );
    }
    logger.log('Notes sync totals:');
    for (const [outcome, count] of Object.entries(result.totals)) {
        logger.log(`  ${outcome}: ${count}`);
    }
}

function buildTotals(submissions: NotesSyncSubmissionSummary[]): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const submission of submissions) {
        totals[submission.outcome] = (totals[submission.outcome] || 0) + 1;
    }
    return totals;
}

export async function runNotesSync(
    options: NotesSyncOptions,
    dependencies: {
        salesforce: SalesforceNotesSyncClient;
        sapphireSource: SapphireNotesSource;
        sapphireNotes?: SapphireNotesClient;
        now?: () => Date;
        logger?: NotesSyncLogger;
        printSummary?: boolean;
    }
): Promise<NotesSyncRunResult> {
    if ((options.apiDryRun || (options.apply && !options.allLocal)) && !dependencies.sapphireNotes) {
        throw new Error('A Sapphire notes client is required for --apply or --api-dry-run.');
    }

    const logger = dependencies.logger || console;
    const now = dependencies.now || (() => new Date());
    const cases = (await dependencies.salesforce.getOpenCasesForNotesSync({
        submissionId: options.submissionId,
        limit: options.limit,
    })).map(loadNotesSyncCase);
    const { groups, skippedNoSubmissionId } = groupBySubmission(cases);
    const submissionNotes = groups.size === 0
        ? []
        : await dependencies.sapphireSource.fetchSubmissionNotes([...groups.keys()]);
    const sapphireNotesBySubmission = new Map<string, string | null>();

    for (const submission of submissionNotes) {
        const submissionId = submission.SUBMISSIONID?.trim();
        if (!submissionId || !groups.has(submissionId)) continue;
        sapphireNotesBySubmission.set(submissionId, submission.NOTES);
    }

    const plans: SubmissionPlan[] = [];
    for (const [submissionId, siblings] of groups) {
        if (!sapphireNotesBySubmission.has(submissionId)) {
            plans.push({
                submissionId,
                cases: siblings,
                decisions: [],
                action: 'status',
                summaryOutcome: 'Error',
                message: 'Submission was absent from the Sapphire submission-notes response.',
                status: 'Error',
            });
        } else {
            plans.push(planSubmission(submissionId, siblings, sapphireNotesBySubmission.get(submissionId)!));
        }
    }

    const summaries = new Map<string, NotesSyncSubmissionSummary>();
    const setSummary = (summary: NotesSyncSubmissionSummary) => summaries.set(summary.submissionId, summary);

    const localOnlyActions: NotesDecision['action'][] = ['baseline', 'setBase', 'pull', 'noop'];
    const nonLocalPlans = plans.filter((plan) =>
        plan.action !== 'noWrite' ||
        plan.decisions.some(({ decision }) => !localOnlyActions.includes(decision.action))
    );
    if (options.apply && options.allLocal && nonLocalPlans.length > 0) {
        const requiringSapphire = nonLocalPlans
            .filter((plan) => plan.decisions.some(({ decision }) =>
                decision.action === 'push' || decision.action === 'merge'
            ))
            .map((plan) => plan.submissionId);
        const message = requiringSapphire.length > 0
            ? `--apply --all-local refused: Sapphire writes are planned for ${requiringSapphire.join(', ')}. ` +
                'Use --apply --submission <id> for each.'
            : '--apply --all-local refused: not every Case has a baseline, setBase, pull, or noop decision.';
        for (const plan of plans) setSummary(makeSummary(plan, 'AllLocalRefused', message));
        const result = {
            submissions: plans.map((plan) => summaries.get(plan.submissionId)!),
            totals: buildTotals(plans.map((plan) => summaries.get(plan.submissionId)!)),
            refused: true,
            writeCapReached: false,
        };
        if (dependencies.printSummary !== false) printResult(result, logger);
        return result;
    }

    for (const plan of plans) {
        if (plan.action === 'status') {
            try {
                if (options.apply && plan.status) {
                    await updateStatus(dependencies.salesforce, plan, plan.status, plan.message);
                }
                setSummary(makeSummary(plan));
            } catch (err) {
                setSummary(makeSummary(plan, 'Error', errorMessage(err)));
            }
        } else if (plan.action === 'noWrite') {
            try {
                if (options.apply) await applyNoWritePlan(dependencies.salesforce, plan, now());
                setSummary(makeSummary(plan));
            } catch (err) {
                setSummary(makeSummary(plan, 'Error', errorMessage(err)));
            }
        }
    }

    const allWritePlans = plans.filter((plan): plan is SubmissionPlan & { write: WritePlan } =>
        plan.action === 'write' && plan.write !== undefined
    );
    const maxWrites = options.maxWrites;
    const writePlans = options.apply && maxWrites !== undefined
        ? allWritePlans.slice(0, maxWrites)
        : allWritePlans;
    const cappedWritePlans = options.apply && maxWrites !== undefined
        ? allWritePlans.slice(maxWrites)
        : [];
    if (cappedWritePlans.length > 0) {
        for (const plan of cappedWritePlans) {
            setSummary(makeSummary(
                plan,
                'WriteCapReached',
                `Sapphire write cap of ${maxWrites} reached; this submission was not written.`
            ));
        }
    }
    if (!options.apply && !options.apiDryRun) {
        for (const plan of writePlans) {
            setSummary(makeSummary(
                plan,
                'WouldSend',
                `Would append ${JSON.stringify(plan.write.appendText)} with ExpectedNotes from Sapphire.`
            ));
        }
    } else {
        const updates = writePlans.map((plan) => ({
            SubmissionId: plan.submissionId,
            ExpectedNotes: plan.write.expectedNotes,
            AppendText: plan.write.appendText,
        }));
        const plansBySubmission = new Map(writePlans.map((plan) => [plan.submissionId, plan]));
        for (const chunk of chunkNotesUpdates(updates)) {
            try {
                const response = await dependencies.sapphireNotes!.appendNotesChunk(
                    chunk,
                    !options.apply
                );
                const results = new Map(response.Results.map((result) => [result.SubmissionId, result]));
                for (const update of chunk) {
                    const plan = plansBySubmission.get(update.SubmissionId)!;
                    try {
                        setSummary(await handleSapphireResult(
                            dependencies.salesforce,
                            plan,
                            results.get(update.SubmissionId),
                            options.apply,
                            now()
                        ));
                    } catch (err) {
                        setSummary(makeSummary(plan, 'Error', errorMessage(err)));
                    }
                }
            } catch (err) {
                const message = errorMessage(err);
                for (const update of chunk) {
                    const plan = plansBySubmission.get(update.SubmissionId)!;
                    try {
                        if (options.apply) {
                            await updateStatus(dependencies.salesforce, plan, 'Error', message);
                        }
                        setSummary(makeSummary(plan, 'Error', message));
                    } catch (statusError) {
                        setSummary(makeSummary(plan, 'Error', errorMessage(statusError)));
                    }
                }
            }
        }
    }

    const orderedSummaries = plans.map((plan) => summaries.get(plan.submissionId) || makeSummary(
        plan,
        'Error',
        'No result was recorded for this submission.'
    ));
    const totals = buildTotals(orderedSummaries);
    if (skippedNoSubmissionId > 0) {
        totals['Skipped: no submission ID'] = skippedNoSubmissionId;
    }
    const result = {
        submissions: orderedSummaries,
        totals,
        refused: false,
        writeCapReached: cappedWritePlans.length > 0,
    };
    printResult(result, logger);
    return result;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        console.log(NOTES_SYNC_USAGE);
        return;
    }

    const options = parseNotesSyncOptions(args);
    // Delayed import keeps the command's environment loading out of fake-client tests.
    const { getConfig, getNotesConfig } = await import('./config');
    const config = getConfig();
    const salesforce = new SalesforceHoldClient(config.salesforce);
    const sapphireSource = new OracleHoldClient(config.oracle);
    const writeConfig = options.apiDryRun || (options.apply && !options.allLocal)
        ? getNotesConfig()
        : null;
    const sapphireNotes = writeConfig
        ? new SapphireNotesApiClient({
            baseUrl: config.oracle.baseUrl,
            oracleConnectName: writeConfig.sapphireWriteConnectName,
        })
        : undefined;

    console.log(`Mode: ${options.apply ? 'APPLY' : 'DRY RUN'}`);
    await salesforce.login();
    await sapphireSource.connect();
    try {
        const result = await runNotesSync(options, { salesforce, sapphireSource, sapphireNotes });
        if (result.refused) process.exitCode = 1;
    } finally {
        await sapphireSource.close();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Notes sync failed:', err);
        process.exitCode = 1;
    });
}
