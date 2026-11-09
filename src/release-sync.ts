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

interface ReleaseSyncOptions {
    onlyHoldIds: string[];
    apply: boolean;
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

async function main(): Promise<void> {
    const options = getOptions();
    const config = getConfig();
    const releaseConfig = getReleaseConfig();
    const dryRun = !options.apply;

    console.log(`Mode: ${dryRun ? 'DRY RUN' : 'APPLY'}`);
    console.log(`Sapphire write connection: ${releaseConfig.sapphireWriteConnectName}`);
    console.log(`ReleasedBy: ${releaseConfig.releasedBy}`);

    const sf = new SalesforceHoldClient(config.salesforce);
    await sf.login();

    const pendingCases = await sf.getResolvedCasesPendingRelease(options.onlyHoldIds);
    console.log(`Found ${pendingCases.length} Salesforce Case(s) pending Sapphire release.`);

    const caseByHoldId = new Map<string, ResolvedCasePendingRelease>();
    const releases: SapphireRelease[] = pendingCases.map((pendingCase) => {
        caseByHoldId.set(pendingCase.holdId, pendingCase);
        return {
            HoldId: pendingCase.holdId,
            ReleasedBy: releaseConfig.releasedBy,
            CaseNumber: pendingCase.caseNumber,
        };
    });

    const client = new SapphireReleaseClient({
        baseUrl: config.oracle.baseUrl,
        oracleConnectName: releaseConfig.sapphireWriteConnectName,
    });
    const chunks = chunkReleases(releases);
    const counts = createOutcomeCounts();
    const failedCaseNumbers = new Set<string>();
    const dryRunRows: Array<{
        CaseNumber: string;
        HoldId: string;
        ReleasedBy: string;
        Outcome: ReleaseOutcome;
        Message: string;
    }> = [];
    let hasPerHoldError = false;

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        const chunkHoldIds = new Set(chunk.map((release) => release.HoldId));
        const chunkCases = new Map(
            [...caseByHoldId.entries()].filter(([holdId]) => chunkHoldIds.has(holdId))
        );

        let results: SapphireReleaseResult[];
        try {
            const response = await client.releaseChunk(chunk, dryRun);
            results = response.Results;
        } catch (err) {
            for (const pendingCase of chunkCases.values()) {
                failedCaseNumbers.add(pendingCase.caseNumber);
            }
            const notSent = chunks.slice(chunkIndex + 1).flat();
            console.error(
                `Release chunk failed for hold IDs: ${chunk.map((release) => release.HoldId).join(', ')}`,
                err
            );
            console.error(
                `Holds not sent: ${notSent.length > 0
                    ? notSent.map((release) => release.HoldId).join(', ')
                    : '(none)'}`
            );
            if (dryRun) printDryRunTable(dryRunRows);
            printSummary(counts, failedCaseNumbers, notSent);
            throw err;
        }

        const returnedHoldIds = new Set<string>();
        try {
            for (const result of results) {
                counts[result.Outcome]++;
                returnedHoldIds.add(result.HoldId);
                const pendingCase = chunkCases.get(result.HoldId);

                if (dryRun) {
                    dryRunRows.push({
                        CaseNumber: pendingCase?.caseNumber ?? result.CaseNumber,
                        HoldId: result.HoldId,
                        ReleasedBy: releaseConfig.releasedBy,
                        Outcome: result.Outcome,
                        Message: result.Message ?? '',
                    });
                }

                if (!pendingCase) {
                    console.warn(
                        `Sapphire returned hold ${result.HoldId}, but it did not match a Case in this chunk.`
                    );
                    continue;
                }

                if (result.Outcome === 'NotFound' ||
                    result.Outcome === 'Rejected' ||
                    result.Outcome === 'Error') {
                    failedCaseNumbers.add(pendingCase.caseNumber);
                }
                if (result.Outcome === 'Error') hasPerHoldError = true;

                if (dryRun) continue;

                if (result.Outcome === 'Released' || result.Outcome === 'AlreadyReleased') {
                    await sf.recordReleaseResult(
                        pendingCase.caseId,
                        true,
                        releaseNote(result)
                    );
                } else if (result.Outcome === 'NotFound' ||
                    result.Outcome === 'Rejected' ||
                    result.Outcome === 'Error') {
                    await sf.recordReleaseResult(
                        pendingCase.caseId,
                        false,
                        result.Message
                    );
                }
            }
        } catch (err) {
            for (const pendingCase of chunkCases.values()) {
                failedCaseNumbers.add(pendingCase.caseNumber);
            }
            const notSent = chunks.slice(chunkIndex + 1).flat();
            console.error(
                `Could not record all results for chunk hold IDs: ${chunk
                    .map((release) => release.HoldId)
                    .join(', ')}`,
                err
            );
            console.error(
                `Holds not sent: ${notSent.length > 0
                    ? notSent.map((release) => release.HoldId).join(', ')
                    : '(none)'}`
            );
            if (dryRun) printDryRunTable(dryRunRows);
            printSummary(counts, failedCaseNumbers, notSent);
            throw err;
        }

        for (const release of chunk) {
            if (!returnedHoldIds.has(release.HoldId)) {
                const pendingCase = chunkCases.get(release.HoldId);
                if (pendingCase) failedCaseNumbers.add(pendingCase.caseNumber);
                console.warn(
                    `No Sapphire result returned for Case ${release.CaseNumber}, hold ${release.HoldId}; ` +
                    'Salesforce was left untouched.'
                );
            }
        }
    }

    if (dryRun) printDryRunTable(dryRunRows);
    printSummary(counts, failedCaseNumbers, []);

    if (hasPerHoldError) {
        throw new Error('One or more Sapphire release results had outcome Error.');
    }
}

main().catch((err) => {
    console.error('Release sync failed:', err);
    process.exit(1);
});
