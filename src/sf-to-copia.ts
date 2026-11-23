import { getConfig, getCopiaReleaseConfig } from './config';
import { CopiaStaffMap, findCopiaStaffId, loadCopiaStaffMap } from './copia-staff-map';
import {
    chunkCopiaReleases,
    CopiaRelease,
    CopiaReleaseClient,
    CopiaReleaseOutcome,
    CopiaReleaseResult,
    parseCopiaDryRunDetails,
} from './services/copia-release-client';
import {
    ResolvedCopiaCasePendingRelease,
    SalesforceHoldClient,
} from './services/salesforce-client';

export const DEFAULT_COPIA_MAX_WRITES = 25;
// Copia Case Description is a generated join of Copia comments, not CS resolution text.
// Keep this one constant so the release reason is deliberately simple to change later.
export const COPIA_RELEASE_REASON = 'released';
export const SF_TO_COPIA_USAGE = [
    'Usage: sf-to-copia [--dry-run|--apply] [--api-dry-run] [--only-hold-ids <comma-separated-8-digit-ids>] [--limit <n>] [--max-writes <n>]',
    '  --dry-run               Preview releases (default; requests Copia API dry-run validation).',
    '  --apply                 Apply releases; requires --only-hold-ids in Dev mode.',
    '  --api-dry-run           Explicitly request Copia API dry-run validation (also the default in dry-run mode).',
    '  --only-hold-ids <ids>   Dev allow-list for releases; required with --apply.',
    '  --limit <n>             Limit Salesforce candidates before processing.',
    `  --max-writes <n>        Cap Copia releases in apply mode (default ${DEFAULT_COPIA_MAX_WRITES}).`,
].join('\n');

const OUTCOMES: CopiaReleaseOutcome[] = [
    'Updated',
    'WouldUpdate',
    'AlreadyReleased',
    'Changed',
    'NotFound',
    'Rejected',
    'Error',
];

export interface SfToCopiaOptions {
    apply: boolean;
    apiDryRun: boolean;
    onlyHoldIds?: string[];
    limit?: number;
    maxWrites: number;
}

export interface SfToCopiaLogger {
    log(message: string): void;
    error?(message: string): void;
}

export interface CopiaReleaseSalesforceClient {
    getResolvedCopiaCasesPendingRelease(
        onlyHoldIds?: string[]
    ): Promise<ResolvedCopiaCasePendingRelease[]>;
    recordCopiaReleaseResult(caseId: string, note: string): Promise<void>;
}

export interface CopiaReleaseApiClient {
    releaseChunk(releases: CopiaRelease[], apply: boolean): Promise<{ Results: CopiaReleaseResult[] }>;
}

export interface SfToCopiaRunResult {
    candidateCount: number;
    attemptedCount: number;
    writeCapReached: boolean;
    counts: Record<CopiaReleaseOutcome, number>;
    failedCaseNumbers: string[];
    dryRunRows: Array<{
        CaseNumber: string;
        HoldId: string;
        SourceResolvedBy: string;
        CopiaStaffId: string | null;
        StaffKey: number | null;
        Reason: string;
        ChangeLogMessage: string | null;
        Outcome: CopiaReleaseOutcome;
        Message: string;
    }>;
    hasError: boolean;
    errors: string[];
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function parseHoldIds(value: string | undefined): string[] {
    if (!value || value.startsWith('--')) throw new Error(SF_TO_COPIA_USAGE);
    const holdIds = [...new Set(value.split(',').map((holdId) => holdId.trim()))];
    if (holdIds.length === 0 || holdIds.some((holdId) => !/^\d{8}$/.test(holdId))) {
        throw new Error(SF_TO_COPIA_USAGE);
    }
    return holdIds;
}

export function parseSfToCopiaOptions(args: string[]): SfToCopiaOptions {
    let apply = false;
    let dryRun = false;
    let apiDryRun = false;
    let onlyHoldIds: string[] | undefined;
    let limit: number | undefined;
    let maxWrites = DEFAULT_COPIA_MAX_WRITES;

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--apply') {
            apply = true;
        } else if (arg === '--dry-run') {
            dryRun = true;
        } else if (arg === '--api-dry-run') {
            apiDryRun = true;
        } else if (arg === '--only-hold-ids') {
            if (onlyHoldIds) throw new Error(SF_TO_COPIA_USAGE);
            onlyHoldIds = parseHoldIds(args[++index]);
        } else if (arg === '--limit' || arg === '--max-writes') {
            const value = args[++index];
            const parsed = Number(value);
            if (!value || !Number.isSafeInteger(parsed) || parsed <= 0) {
                throw new Error(SF_TO_COPIA_USAGE);
            }
            if (arg === '--limit') {
                if (limit !== undefined) throw new Error(SF_TO_COPIA_USAGE);
                limit = parsed;
            } else {
                maxWrites = parsed;
            }
        } else {
            throw new Error(SF_TO_COPIA_USAGE);
        }
    }

    if (apply && dryRun) throw new Error('--apply and --dry-run cannot be used together.');
    if (apply && apiDryRun) throw new Error('--api-dry-run is only valid in dry-run mode.');
    if (apply && (!onlyHoldIds || onlyHoldIds.length === 0)) {
        throw new Error('--only-hold-ids is required for --apply in Dev mode.');
    }

    return { apply, apiDryRun, onlyHoldIds, limit, maxWrites };
}

function createOutcomeCounts(): Record<CopiaReleaseOutcome, number> {
    return {
        Updated: 0,
        WouldUpdate: 0,
        AlreadyReleased: 0,
        Changed: 0,
        NotFound: 0,
        Rejected: 0,
        Error: 0,
    };
}

function releaseAuditNote(result: CopiaReleaseResult): string {
    return result.Message
        ? `${result.Outcome}: ${result.Message}`
        : result.Outcome;
}

function printDryRunRows(
    rows: SfToCopiaRunResult['dryRunRows'],
    logger: SfToCopiaLogger
): void {
    for (const row of rows) {
        logger.log(`Case ${row.CaseNumber} | hold ${row.HoldId} | ${row.Outcome}`);
        logger.log(`  Resolved By: ${row.SourceResolvedBy}`);
        logger.log(`  Mapped Copia Staff.ID: ${row.CopiaStaffId ?? '(not mapped)'}`);
        logger.log(`  Staff key: ${row.StaffKey === null ? '(not found)' : row.StaffKey}`);
        logger.log(`  Reason: ${row.Reason}`);
        logger.log(`  ChangeLog message: ${row.ChangeLogMessage ?? '(none)'}`);
        if (row.Outcome !== 'WouldUpdate') logger.log(`  Endpoint message: ${row.Message}`);
    }
}

function printSummary(result: SfToCopiaRunResult, logger: SfToCopiaLogger): void {
    logger.log('Salesforce-to-Copia release summary:');
    for (const outcome of OUTCOMES) {
        logger.log(`  ${outcome}: ${result.counts[outcome]}`);
    }
    logger.log(`  Candidate Cases: ${result.candidateCount}`);
    logger.log(`  Attempted holds: ${result.attemptedCount}`);
    if (result.writeCapReached) {
        logger.log('  Copia apply write cap reached; remaining candidates were not sent.');
    }
    logger.log(
        `  Failure Case numbers: ${result.failedCaseNumbers.length > 0
            ? result.failedCaseNumbers.join(', ')
            : '(none)'}`
    );
}

/** Injectable workflow for Salesforce-to-Copia releases. */
export async function runSfToCopia(
    options: SfToCopiaOptions,
    dependencies: {
        salesforce: CopiaReleaseSalesforceClient;
        copia: CopiaReleaseApiClient;
        staffMap: CopiaStaffMap;
        logger?: SfToCopiaLogger;
    }
): Promise<SfToCopiaRunResult> {
    const logger = dependencies.logger || console;
    const dryRun = !options.apply;
    const pendingCases = await dependencies.salesforce
        .getResolvedCopiaCasesPendingRelease(options.onlyHoldIds);
    const limitedCases = options.limit === undefined
        ? pendingCases
        : pendingCases.slice(0, options.limit);
    const caseByOrderedPanelKey = new Map<number, ResolvedCopiaCasePendingRelease>();
    const releaseByOrderedPanelKey = new Map<number, CopiaRelease>();
    const releases: CopiaRelease[] = [];
    const counts = createOutcomeCounts();
    const failedCaseNumbers = new Set<string>();
    const dryRunRows: SfToCopiaRunResult['dryRunRows'] = [];
    const errors: string[] = [];
    let hasError = false;

    const mappedCandidates: Array<{
        pendingCase: ResolvedCopiaCasePendingRelease;
        orderedPanelKey: number;
        sourceResolvedBy: string;
        copiaStaffId: string;
    }> = [];

    for (const pendingCase of limitedCases) {
        const orderedPanelKey = Number(pendingCase.holdId);
        if (!Number.isSafeInteger(orderedPanelKey) || !/^\d{8}$/.test(pendingCase.holdId)) {
            throw new Error(`Salesforce returned invalid Copia hold ID ${pendingCase.holdId} for Case ${pendingCase.caseNumber}.`);
        }
        const sourceResolvedBy = pendingCase.resolvedBy?.trim() || '(blank)';
        const mapping = findCopiaStaffId(dependencies.staffMap, pendingCase.resolvedBy);
        if (!mapping.staffId) {
            counts.Rejected++;
            failedCaseNumbers.add(pendingCase.caseNumber);
            if (dryRun) {
                dryRunRows.push({
                    CaseNumber: pendingCase.caseNumber,
                    HoldId: pendingCase.holdId,
                    SourceResolvedBy: sourceResolvedBy,
                    CopiaStaffId: null,
                    StaffKey: null,
                    Reason: COPIA_RELEASE_REASON,
                    ChangeLogMessage: null,
                    Outcome: 'Rejected',
                    Message: `No Copia staff mapping for ${sourceResolvedBy}`,
                });
            }
            continue;
        }
        mappedCandidates.push({
            pendingCase,
            orderedPanelKey,
            sourceResolvedBy,
            copiaStaffId: mapping.staffId,
        });
    }

    const candidatesToSend = options.apply
        ? mappedCandidates.slice(0, options.maxWrites)
        : mappedCandidates;
    const writeCapReached = options.apply && mappedCandidates.length > candidatesToSend.length;

    for (const candidate of candidatesToSend) {
        const { pendingCase, orderedPanelKey, copiaStaffId } = candidate;
        const release: CopiaRelease = {
            OrderedPanelKey: orderedPanelKey,
            // The endpoint intentionally continues to match this exact value to Staff.ID.
            ResolvedBy: copiaStaffId,
            Reason: COPIA_RELEASE_REASON,
        };
        caseByOrderedPanelKey.set(orderedPanelKey, pendingCase);
        releaseByOrderedPanelKey.set(orderedPanelKey, release);
        releases.push(release);
    }

    for (const chunk of chunkCopiaReleases(releases)) {
        let results: CopiaReleaseResult[];
        try {
            // A non-apply run always invokes the endpoint with Apply=false so it can validate Staff.ID,
            // current OrderedPanel state, and the exact Central-time ChangeLog text without writing.
            results = (await dependencies.copia.releaseChunk(chunk, !dryRun)).Results;
        } catch (err) {
            const message = errorMessage(err);
            errors.push(`Copia release chunk failed for hold IDs ${chunk.map((release) => release.OrderedPanelKey).join(', ')}: ${message}`);
            for (const release of chunk) {
                counts.Error++;
                const pendingCase = caseByOrderedPanelKey.get(release.OrderedPanelKey);
                if (pendingCase) failedCaseNumbers.add(pendingCase.caseNumber);
            }
            hasError = true;
            break;
        }

        const returnedOrderedPanelKeys = new Set<number>();
        for (const result of results) {
            if (!OUTCOMES.includes(result.Outcome)) {
                hasError = true;
                errors.push(`Copia returned an unknown outcome for hold ${result.OrderedPanelKey}: ${result.Outcome}`);
                continue;
            }
            counts[result.Outcome]++;
            returnedOrderedPanelKeys.add(result.OrderedPanelKey);
            const pendingCase = caseByOrderedPanelKey.get(result.OrderedPanelKey);
            const release = releaseByOrderedPanelKey.get(result.OrderedPanelKey);
            const sourceResolvedBy = pendingCase?.resolvedBy?.trim() || '(unknown)';

            if (dryRun) {
                const details = result.Outcome === 'WouldUpdate'
                    ? parseCopiaDryRunDetails(result.Message)
                    : null;
                dryRunRows.push({
                    CaseNumber: pendingCase?.caseNumber ?? '(unknown)',
                    HoldId: String(result.OrderedPanelKey),
                    SourceResolvedBy: sourceResolvedBy,
                    CopiaStaffId: release?.ResolvedBy ?? null,
                    StaffKey: details?.staffKey ?? null,
                    Reason: release?.Reason ?? '(unknown)',
                    ChangeLogMessage: details?.changeLogMessage ?? null,
                    Outcome: result.Outcome,
                    Message: result.Message ?? '',
                });
            }

            if (!pendingCase) continue;
            if (result.Outcome === 'Error') hasError = true;
            if (result.Outcome === 'Changed' ||
                result.Outcome === 'NotFound' ||
                result.Outcome === 'Rejected' ||
                result.Outcome === 'Error') {
                failedCaseNumbers.add(pendingCase.caseNumber);
            }

            if (dryRun) continue;
            if (result.Outcome === 'Updated' || result.Outcome === 'AlreadyReleased') {
                try {
                    await dependencies.salesforce.recordCopiaReleaseResult(
                        pendingCase.caseId,
                        releaseAuditNote(result)
                    );
                } catch (err) {
                    hasError = true;
                    errors.push(`Could not record Copia release result for hold ${result.OrderedPanelKey}: ${errorMessage(err)}`);
                }
            }
        }

        for (const release of chunk) {
            if (!returnedOrderedPanelKeys.has(release.OrderedPanelKey)) {
                hasError = true;
                counts.Error++;
                const pendingCase = caseByOrderedPanelKey.get(release.OrderedPanelKey);
                if (pendingCase) failedCaseNumbers.add(pendingCase.caseNumber);
                errors.push(`No Copia release result returned for hold ${release.OrderedPanelKey}.`);
            }
        }
        if (hasError && errors.length > 0) break;
    }

    const result: SfToCopiaRunResult = {
        candidateCount: limitedCases.length,
        attemptedCount: releases.length,
        writeCapReached,
        counts,
        failedCaseNumbers: [...failedCaseNumbers],
        dryRunRows,
        hasError,
        errors,
    };
    if (dryRun) printDryRunRows(result.dryRunRows, logger);
    printSummary(result, logger);
    return result;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        console.log(SF_TO_COPIA_USAGE);
        return;
    }

    const options = parseSfToCopiaOptions(args);
    const config = getConfig();
    const releaseConfig = getCopiaReleaseConfig();
    const staffMap = loadCopiaStaffMap();
    const salesforce = new SalesforceHoldClient(config.salesforce);
    const copia = new CopiaReleaseClient({
        baseUrl: config.copia.baseUrl,
        copiaConnectName: releaseConfig.copiaWriteConnectName,
    });

    console.log(`Mode: ${options.apply ? 'APPLY' : 'DRY RUN'}`);
    console.log(`Copia write connection: ${releaseConfig.copiaWriteConnectName}`);
    await salesforce.login();
    const result = await runSfToCopia(options, { salesforce, copia, staffMap });
    for (const error of result.errors) console.error(error);
    if (result.hasError) process.exitCode = 1;
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Salesforce-to-Copia sync failed:', err);
        process.exitCode = 1;
    });
}
