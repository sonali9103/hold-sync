import { getConfig, getNotesConfig, getReleaseConfig } from './config';
import {
    assertReleaseDevAllowList,
    ReleaseSyncOptions,
    ReleaseSyncRunResult,
    runReleaseSync,
} from './release-sync';
import {
    NotesSyncOptions,
    NotesSyncRunResult,
    runNotesSync,
} from './notes-sync';
import { OracleHoldClient } from './services/oracle-client';
import { SalesforceHoldClient } from './services/salesforce-client';
import { SapphireNotesApiClient } from './services/sapphire-notes-client';
import { SapphireReleaseClient } from './services/sapphire-release-client';

export const DEFAULT_MAX_WRITES = 25;
export const SF_TO_SAPPHIRE_USAGE = [
    'Usage: sf-to-sapphire [--dry-run|--apply] [--api-dry-run] [--only-hold-ids <comma-separated-ids>] [--limit <n>] [--max-writes <n>]',
    '  --dry-run               Preview both steps (default).',
    '  --apply                 Apply release and notes writes; requires --only-hold-ids in Dev mode.',
    '  --api-dry-run           Request Sapphire dry-run validation for both steps.',
    '  --only-hold-ids <ids>   Dev allow-list for release writes; required with --apply.',
    '  --limit <n>             Limit each step independently.',
    `  --max-writes <n>        Cap Sapphire notes writes per run (default ${DEFAULT_MAX_WRITES}).`,
].join('\n');

export interface SfToSapphireOptions {
    apply: boolean;
    apiDryRun: boolean;
    onlyHoldIds?: string[];
    limit?: number;
    maxWrites: number;
}

export interface SfToSapphireLogger {
    log(message: string): void;
}

export interface SfToSapphireRunResult {
    release?: ReleaseSyncRunResult;
    notes?: NotesSyncRunResult;
    releaseError?: string;
    notesError?: string;
    hasError: boolean;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function parseHoldIds(value: string | undefined): string[] {
    if (!value || value.startsWith('--')) throw new Error(SF_TO_SAPPHIRE_USAGE);
    const holdIds = [...new Set(value.split(',').map((holdId) => holdId.trim()))];
    if (holdIds.length === 0 || holdIds.some((holdId) => !/^[0-9]+$/.test(holdId))) {
        throw new Error(SF_TO_SAPPHIRE_USAGE);
    }
    return holdIds;
}

export function parseSfToSapphireOptions(args: string[]): SfToSapphireOptions {
    let apply = false;
    let dryRun = false;
    let apiDryRun = false;
    let onlyHoldIds: string[] | undefined;
    let limit: number | undefined;
    let maxWrites = DEFAULT_MAX_WRITES;

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--apply') {
            apply = true;
        } else if (arg === '--dry-run') {
            dryRun = true;
        } else if (arg === '--api-dry-run') {
            apiDryRun = true;
        } else if (arg === '--only-hold-ids') {
            if (onlyHoldIds) throw new Error(SF_TO_SAPPHIRE_USAGE);
            onlyHoldIds = parseHoldIds(args[++index]);
        } else if (arg === '--limit' || arg === '--max-writes') {
            const value = args[++index];
            const parsed = Number(value);
            if (!value || !Number.isSafeInteger(parsed) || parsed <= 0) {
                throw new Error(SF_TO_SAPPHIRE_USAGE);
            }
            if (arg === '--limit') {
                if (limit !== undefined) throw new Error(SF_TO_SAPPHIRE_USAGE);
                limit = parsed;
            } else {
                maxWrites = parsed;
            }
        } else {
            throw new Error(SF_TO_SAPPHIRE_USAGE);
        }
    }

    if (apply && dryRun) throw new Error('--apply and --dry-run cannot be used together.');
    if (apply && apiDryRun) throw new Error('--api-dry-run is only valid in dry-run mode.');
    if (apply) assertReleaseDevAllowList(onlyHoldIds);

    return { apply, apiDryRun, onlyHoldIds, limit, maxWrites };
}

function releaseHasError(result: ReleaseSyncRunResult): boolean {
    return result.hasError || result.counts.Error > 0;
}

function notesHasError(result: NotesSyncRunResult): boolean {
    return (result.totals.Error || 0) > 0;
}

function printCombinedSummary(result: SfToSapphireRunResult, logger: SfToSapphireLogger): void {
    logger.log('Salesforce-to-Sapphire summary:');
    if (result.release) {
        logger.log(
            `  Release: Released=${result.release.counts.Released}, ` +
            `WouldRelease=${result.release.counts.WouldRelease}, Error=${result.release.counts.Error}`
        );
    } else {
        logger.log(`  Release: failed (${result.releaseError || 'unknown error'})`);
    }
    if (result.notes) {
        const noteTotals = Object.entries(result.notes.totals)
            .map(([outcome, count]) => `${outcome}=${count}`)
            .join(', ');
        logger.log(`  Notes: ${noteTotals || 'no submissions'}`);
        if (result.notes.writeCapReached) {
            logger.log('  Notes: Sapphire write cap reached; remaining submissions were not written.');
        }
    } else {
        logger.log(`  Notes: failed (${result.notesError || 'unknown error'})`);
    }
    logger.log(`  Result: ${result.hasError ? 'ERROR' : 'complete'}`);
}

export async function runSfToSapphire(
    options: SfToSapphireOptions,
    dependencies: {
        runRelease: (options: ReleaseSyncOptions) => Promise<ReleaseSyncRunResult>;
        runNotes: (options: NotesSyncOptions) => Promise<NotesSyncRunResult>;
        logger?: SfToSapphireLogger;
    }
): Promise<SfToSapphireRunResult> {
    let release: ReleaseSyncRunResult | undefined;
    let notes: NotesSyncRunResult | undefined;
    let releaseError: string | undefined;
    let notesError: string | undefined;

    try {
        release = await dependencies.runRelease({
            apply: options.apply,
            apiDryRun: options.apiDryRun,
            onlyHoldIds: options.onlyHoldIds,
            limit: options.limit,
        });
    } catch (err) {
        releaseError = errorMessage(err);
    }

    try {
        notes = await dependencies.runNotes({
            apply: options.apply,
            apiDryRun: options.apiDryRun,
            limit: options.limit,
            maxWrites: options.maxWrites,
        });
    } catch (err) {
        notesError = errorMessage(err);
    }

    const result = {
        release,
        notes,
        releaseError,
        notesError,
        hasError: releaseError !== undefined ||
            notesError !== undefined ||
            (release !== undefined && releaseHasError(release)) ||
            (notes !== undefined && notesHasError(notes)),
    };
    printCombinedSummary(result, dependencies.logger || console);
    return result;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        console.log(SF_TO_SAPPHIRE_USAGE);
        return;
    }

    const options = parseSfToSapphireOptions(args);
    const config = getConfig();
    const releaseConfig = getReleaseConfig();
    const salesforce = new SalesforceHoldClient(config.salesforce);
    const releaseClient = new SapphireReleaseClient({
        baseUrl: config.oracle.baseUrl,
        oracleConnectName: releaseConfig.sapphireWriteConnectName,
    });
    const oracle = new OracleHoldClient(config.oracle);
    const notesConfig = options.apply || options.apiDryRun ? getNotesConfig() : null;
    const notesClient = notesConfig
        ? new SapphireNotesApiClient({
            baseUrl: config.oracle.baseUrl,
            oracleConnectName: notesConfig.sapphireWriteConnectName,
        })
        : undefined;

    await salesforce.login();
    const result = await runSfToSapphire(options, {
        runRelease: (releaseOptions) => runReleaseSync(releaseOptions, {
            salesforce,
            sapphire: releaseClient,
            releasedBy: releaseConfig.releasedBy,
        }),
        runNotes: async (notesOptions) => {
            await oracle.connect();
            try {
                return await runNotesSync(notesOptions, {
                    salesforce,
                    sapphireSource: oracle,
                    sapphireNotes: notesClient,
                    printSummary: false,
                });
            } finally {
                await oracle.close();
            }
        },
    });
    if (result.hasError) process.exitCode = 1;
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Salesforce-to-Sapphire sync failed:', err);
        process.exitCode = 1;
    });
}
