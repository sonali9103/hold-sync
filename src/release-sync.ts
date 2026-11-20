import { getConfig, getReleaseConfig } from './config';
import {
    chunkReleases,
    ReleaseOutcome,
    SapphireRelease,
    SapphireReleaseResult,
    SapphireReleaseClient,
} from './services/sapphire-release-client';
import {
    ResolvedCasePendingRelease,
    SalesforceHoldClient,
} from './services/salesforce-client';

// Remove after Source_Release_Synced__c is backfilled on existing Resolved Cases.
const REQUIRE_ONLY_HOLD_IDS = true;
const USAGE = 'Usage: release-sync.ts --only-hold-ids <comma-separated-ids> [--apply]';
const OUTCOMES: ReleaseOutcome[] = [
    'Released',
    'WouldRelease',
    'AlreadyReleased',
    'NotFound',
    'Rejected',
    'Error',
];
const MAX_RELEASED_BY_LENGTH = 20;

export interface ReleaseSyncOptions {
    onlyHoldIds?: string[];
    apply: boolean;
    limit?: number;
    apiDryRun?: boolean;
}

export interface ReleaseSyncSalesforceClient {
    getResolvedCasesPendingRelease(onlyHoldIds?: string[]): Promise<ResolvedCasePendingRelease[]>;
    recordReleaseResult(caseId: string, synced: boolean, note: string | null): Promise<void>;
}

export interface ReleaseSyncSapphireClient {
    releaseChunk(
        releases: SapphireRelease[],
        dryRun: boolean
    ): Promise<{ Results: SapphireReleaseResult[] }>;
}

export interface ReleaseSyncRunResult {
    candidateCount: number;
    counts: Record<ReleaseOutcome, number>;
    failedCaseNumbers: string[];
    dryRunRows: Array<{
        CaseNumber: string;
        HoldId: string;
        ReleasedBy: string;
        Outcome: ReleaseOutcome;
        Message: string;
    }>;
    hasError: boolean;
    errors: string[];
}

export type ReleasedByResolution =
    | { releasedBy: string }
    | { rejectedMessage: string };

export function resolveReleasedBy(
    caseResolvedBy: string | null,
    fallbackReleasedBy: string
): ReleasedByResolution {
    const resolvedBy = caseResolvedBy?.trim();
    if (!resolvedBy) return { releasedBy: fallbackReleasedBy };

    const normalized = resolvedBy.toLowerCase();
    if (normalized.length > MAX_RELEASED_BY_LENGTH) {
        return {
            rejectedMessage:
                `Resolved_By__c is ${normalized.length} characters after trimming/lowercasing; ` +
                `maximum is ${MAX_RELEASED_BY_LENGTH}. Hold was not released.`,
        };
    }
    return { releasedBy: normalized };
}

export function groupReleasesByReleasedBy(releases: SapphireRelease[]): SapphireRelease[][] {
    const groups = new Map<string, SapphireRelease[]>();
    for (const release of releases) {
        const group = groups.get(release.ReleasedBy);
        if (group) group.push(release);
        else groups.set(release.ReleasedBy, [release]);
    }
    return [...groups.values()];
}

function getOptions(): ReleaseSyncOptions {
    const args = process.argv.slice(2);
    const onlyHoldIdsIndex = args.indexOf('--only-hold-ids');

    if (onlyHoldIdsIndex === -1) {
        if (REQUIRE_ONLY_HOLD_IDS) {
            throw new Error(
                `${USAGE}\n--only-hold-ids is required until existing Resolved Cases are backfilled.`
            );
        }
        return { onlyHoldIds: [], apply: args.includes('--apply') };
    }

    const rawHoldIds = args[onlyHoldIdsIndex + 1];
    if (!rawHoldIds || rawHoldIds.startsWith('--')) {
        throw new Error(USAGE);
    }

    const onlyHoldIds = [...new Set(rawHoldIds.split(',').map((holdId) => holdId.trim()))];
    if (onlyHoldIds.length === 0 || onlyHoldIds.some((holdId) => !/^[0-9]+$/.test(holdId))) {
        throw new Error(USAGE);
    }

    return {
        onlyHoldIds,
        apply: args.includes('--apply'),
    };
}

export function assertReleaseDevAllowList(onlyHoldIds: string[] | undefined): void {
    if (REQUIRE_ONLY_HOLD_IDS && (!onlyHoldIds || onlyHoldIds.length === 0)) {
        throw new Error(
            '--only-hold-ids is required for --apply until existing Resolved Cases are backfilled.'
        );
    }
}

function createOutcomeCounts(): Record<ReleaseOutcome, number> {
    return {
        Released: 0,
        WouldRelease: 0,
        AlreadyReleased: 0,
        NotFound: 0,
        Rejected: 0,
        Error: 0,
    };
}

function printSummary(
    counts: Record<ReleaseOutcome, number>,
    failedCaseNumbers: Set<string>,
    notSent: SapphireRelease[]
): void {
    console.log('Release sync summary:');
    for (const outcome of OUTCOMES) {
        console.log(`  ${outcome}: ${counts[outcome]}`);
    }
    console.log(
        `  Failure Case numbers: ${failedCaseNumbers.size > 0
            ? [...failedCaseNumbers].join(', ')
            : '(none)'}`
    );
    console.log(`  Holds not sent: ${notSent.length}`);
}

function printDryRunTable(
    rows: Array<{
        CaseNumber: string;
        HoldId: string;
        ReleasedBy: string;
        Outcome: ReleaseOutcome;
        Message: string;
    }>
): void {
    console.table(rows);
}

function releaseNote(result: SapphireReleaseResult): string {
    return result.Message
        ? `${result.Outcome}: ${result.Message}`
        : result.Outcome;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Injectable release workflow shared by the combined Salesforce-to-Sapphire command.
 * The standalone command retains its stricter CLI parsing and its existing console output.
 */
export async function runReleaseSync(
    options: ReleaseSyncOptions,
    dependencies: {
        salesforce: ReleaseSyncSalesforceClient;
        sapphire: ReleaseSyncSapphireClient;
        releasedBy: string;
    }
): Promise<ReleaseSyncRunResult> {
    const dryRun = !options.apply || options.apiDryRun === true;
    const pendingCases = await dependencies.salesforce.getResolvedCasesPendingRelease(options.onlyHoldIds);
    const limitedCases = options.limit === undefined
        ? pendingCases
        : pendingCases.slice(0, options.limit);
    const caseByHoldId = new Map<string, ResolvedCasePendingRelease>();
    const releaseByHoldId = new Map<string, SapphireRelease>();
    const counts = createOutcomeCounts();
    const failedCaseNumbers = new Set<string>();
    const dryRunRows: ReleaseSyncRunResult['dryRunRows'] = [];
    const errors: string[] = [];
    let hasError = false;
    const releases: SapphireRelease[] = [];

    for (const pendingCase of limitedCases) {
        const resolution = resolveReleasedBy(pendingCase.resolvedBy, dependencies.releasedBy);
        if ('rejectedMessage' in resolution) {
            counts.Rejected++;
            failedCaseNumbers.add(pendingCase.caseNumber);
            if (dryRun) {
                dryRunRows.push({
                    CaseNumber: pendingCase.caseNumber,
                    HoldId: pendingCase.holdId,
                    ReleasedBy: '',
                    Outcome: 'Rejected',
                    Message: resolution.rejectedMessage,
                });
            } else {
                try {
                    await dependencies.salesforce.recordReleaseResult(
                        pendingCase.caseId,
                        false,
                        resolution.rejectedMessage
                    );
                } catch (err) {
                    hasError = true;
                    errors.push(
                        `Could not record rejected release for hold ${pendingCase.holdId}: ${errorMessage(err)}`
                    );
                }
            }
            continue;
        }
        caseByHoldId.set(pendingCase.holdId, pendingCase);
        const release = {
            HoldId: pendingCase.holdId,
            ReleasedBy: resolution.releasedBy,
            CaseNumber: pendingCase.caseNumber,
        };
        releases.push(release);
        releaseByHoldId.set(release.HoldId, release);
    }

    const chunks = groupReleasesByReleasedBy(releases).flatMap((group) => chunkReleases(group));
    for (const chunk of chunks) {
        let results: SapphireReleaseResult[];
        try {
            results = (await dependencies.sapphire.releaseChunk(chunk, dryRun)).Results;
        } catch (err) {
            const message = errorMessage(err);
            errors.push(`Release chunk failed for hold IDs ${chunk.map((release) => release.HoldId).join(', ')}: ${message}`);
            for (const release of chunk) {
                counts.Error++;
                const pendingCase = caseByHoldId.get(release.HoldId);
                if (pendingCase) failedCaseNumbers.add(pendingCase.caseNumber);
            }
            hasError = true;
            break;
        }

        const returnedHoldIds = new Set<string>();
        for (const result of results) {
            counts[result.Outcome]++;
            returnedHoldIds.add(result.HoldId);
            const pendingCase = caseByHoldId.get(result.HoldId);
            if (dryRun) {
                dryRunRows.push({
                    CaseNumber: pendingCase?.caseNumber ?? result.CaseNumber,
                    HoldId: result.HoldId,
                    ReleasedBy: releaseByHoldId.get(result.HoldId)?.ReleasedBy ?? '',
                    Outcome: result.Outcome,
                    Message: result.Message ?? '',
                });
            }
            if (!pendingCase) continue;

            if (result.Outcome === 'Error') hasError = true;
            if (result.Outcome === 'NotFound' ||
                result.Outcome === 'Rejected' ||
                result.Outcome === 'Error') {
                failedCaseNumbers.add(pendingCase.caseNumber);
            }

            if (dryRun) continue;
            try {
                if (result.Outcome === 'Released' || result.Outcome === 'AlreadyReleased') {
                    await dependencies.salesforce.recordReleaseResult(
                        pendingCase.caseId,
                        true,
                        releaseNote(result)
                    );
                } else if (result.Outcome === 'NotFound' ||
                    result.Outcome === 'Rejected' ||
                    result.Outcome === 'Error') {
                    await dependencies.salesforce.recordReleaseResult(
                        pendingCase.caseId,
                        false,
                        result.Message
                    );
                }
            } catch (err) {
                hasError = true;
                errors.push(`Could not record release result for hold ${result.HoldId}: ${errorMessage(err)}`);
            }
        }

        for (const release of chunk) {
            if (!returnedHoldIds.has(release.HoldId)) {
                hasError = true;
                counts.Error++;
                const pendingCase = caseByHoldId.get(release.HoldId);
                if (pendingCase) failedCaseNumbers.add(pendingCase.caseNumber);
                errors.push(`No Sapphire release result returned for hold ${release.HoldId}.`);
            }
        }
        if (hasError && errors.length > 0) break;
    }

    return {
        candidateCount: limitedCases.length,
        counts,
        failedCaseNumbers: [...failedCaseNumbers],
        dryRunRows,
        hasError,
        errors,
    };
}

async function main(): Promise<void> {
    const options = getOptions();
    const config = getConfig();
    const releaseConfig = getReleaseConfig();
    const dryRun = !options.apply || options.apiDryRun === true;

    console.log(`Mode: ${dryRun ? 'DRY RUN' : 'APPLY'}`);
    console.log(`Sapphire write connection: ${releaseConfig.sapphireWriteConnectName}`);

    const salesforce = new SalesforceHoldClient(config.salesforce);
    await salesforce.login();
    const sapphire = new SapphireReleaseClient({
        baseUrl: config.oracle.baseUrl,
        oracleConnectName: releaseConfig.sapphireWriteConnectName,
    });
    const result = await runReleaseSync(options, {
        salesforce,
        sapphire,
        releasedBy: releaseConfig.releasedBy,
    });

    console.log(`Found ${result.candidateCount} Salesforce Case(s) pending Sapphire release.`);
    if (dryRun) printDryRunTable(result.dryRunRows);
    printSummary(result.counts, new Set(result.failedCaseNumbers), []);
    for (const error of result.errors) console.error(error);
    if (result.hasError) {
        throw new Error('One or more Sapphire release results had outcome Error.');
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Release sync failed:', err);
        process.exit(1);
    });
}
