import { getSalesforceConfig } from './config';
import {
    ResolvedCopiaCaseMissingReleaseSync,
    SalesforceHoldClient,
} from './services/salesforce-client';

export const DEFAULT_COPIA_READ_SYNC_BACKFILL_MAX_WRITES = 25;
export const COPIA_READ_SYNC_BACKFILL_USAGE = [
    'Usage: copia-read-sync-backfill [--dry-run|--apply] [--limit <n>] [--max-writes <n>]',
    '  --dry-run       Preview Source_Release_Synced__c updates (default).',
    '  --apply         Write the marker for identified Copia read-sync Cases.',
    '  --limit <n>     Limit scanned unresolved-marker Cases before classification.',
    `  --max-writes <n> Cap updates in either mode (default ${DEFAULT_COPIA_READ_SYNC_BACKFILL_MAX_WRITES}).`,
].join('\n');

export interface CopiaReadSyncBackfillOptions {
    apply: boolean;
    limit?: number;
    maxWrites: number;
}

export type CopiaResolvedByKind = 'CopiaLastName' | 'SalesforceUsername' | 'Ambiguous';

export interface CopiaReadSyncBackfillSalesforceClient {
    getResolvedCopiaCasesMissingReleaseSync(): Promise<ResolvedCopiaCaseMissingReleaseSync[]>;
    markCopiaReadSyncResolved(caseId: string): Promise<void>;
}

export interface CopiaReadSyncBackfillResult {
    scannedCount: number;
    copiaLastNameCount: number;
    salesforceUsernameCount: number;
    ambiguousCount: number;
    targetedCount: number;
    updatedCount: number;
    writeCapReached: boolean;
    errors: string[];
}

function parsePositiveInteger(value: string | undefined): number {
    const parsed = Number(value);
    if (!value || !Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(COPIA_READ_SYNC_BACKFILL_USAGE);
    }
    return parsed;
}

export function parseCopiaReadSyncBackfillOptions(args: string[]): CopiaReadSyncBackfillOptions {
    let apply = false;
    let dryRun = false;
    let limit: number | undefined;
    let maxWrites = DEFAULT_COPIA_READ_SYNC_BACKFILL_MAX_WRITES;

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--apply') {
            apply = true;
        } else if (arg === '--dry-run') {
            dryRun = true;
        } else if (arg === '--limit') {
            if (limit !== undefined) throw new Error(COPIA_READ_SYNC_BACKFILL_USAGE);
            limit = parsePositiveInteger(args[++index]);
        } else if (arg === '--max-writes') {
            maxWrites = parsePositiveInteger(args[++index]);
        } else {
            throw new Error(COPIA_READ_SYNC_BACKFILL_USAGE);
        }
    }

    if (apply && dryRun) throw new Error('--apply and --dry-run cannot be used together.');
    return { apply, limit, maxWrites };
}

/**
 * Historical Copia sync records a Staff.lastName (normally mixed/upper case); CS resolution
 * automation records a lowercase Salesforce username (for example, ysoto). A lowercase value is
 * intentionally preserved as CS even if it could also be a surname. Unknown formats are skipped.
 */
export function classifyCopiaResolvedBy(value: string | null): CopiaResolvedByKind {
    const trimmed = value?.trim() || '';
    if (!trimmed) return 'Ambiguous';
    if (/^[a-z][a-z0-9._-]*$/.test(trimmed)) return 'SalesforceUsername';
    if (/^[A-Za-z][A-Za-z' -]*$/.test(trimmed) && /[A-Z]/.test(trimmed)) {
        return 'CopiaLastName';
    }
    return 'Ambiguous';
}

function sourceValue(value: string | null): string {
    return value?.trim() || '(blank)';
}

/** Injectable, bounded backfill. Dry run never invokes markCopiaReadSyncResolved. */
export async function runCopiaReadSyncBackfill(
    options: CopiaReadSyncBackfillOptions,
    dependencies: {
        salesforce: CopiaReadSyncBackfillSalesforceClient;
        logger?: { log(message: string): void };
    }
): Promise<CopiaReadSyncBackfillResult> {
    const logger = dependencies.logger || console;
    const allCandidates = await dependencies.salesforce.getResolvedCopiaCasesMissingReleaseSync();
    const candidates = options.limit === undefined ? allCandidates : allCandidates.slice(0, options.limit);
    const eligible: ResolvedCopiaCaseMissingReleaseSync[] = [];
    let salesforceUsernameCount = 0;
    let ambiguousCount = 0;

    for (const candidate of candidates) {
        const kind = classifyCopiaResolvedBy(candidate.resolvedBy);
        if (kind === 'CopiaLastName') {
            eligible.push(candidate);
        } else if (kind === 'SalesforceUsername') {
            salesforceUsernameCount++;
            logger.log(`Case ${candidate.caseNumber} | skipped CS username: ${sourceValue(candidate.resolvedBy)}`);
        } else {
            ambiguousCount++;
            logger.log(`Case ${candidate.caseNumber} | skipped ambiguous Resolved By: ${sourceValue(candidate.resolvedBy)}`);
        }
    }

    const targets = eligible.slice(0, options.maxWrites);
    const writeCapReached = eligible.length > targets.length;
    let updatedCount = 0;
    const errors: string[] = [];
    for (const target of targets) {
        if (!options.apply) {
            logger.log(`Case ${target.caseNumber} | WouldUpdate | Copia last name: ${sourceValue(target.resolvedBy)}`);
            continue;
        }
        try {
            await dependencies.salesforce.markCopiaReadSyncResolved(target.caseId);
            updatedCount++;
            logger.log(`Case ${target.caseNumber} | Updated | Copia last name: ${sourceValue(target.resolvedBy)}`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            errors.push(`Could not mark Case ${target.caseNumber}: ${message}`);
            logger.log(`Case ${target.caseNumber} | Error | ${message}`);
        }
    }

    const result: CopiaReadSyncBackfillResult = {
        scannedCount: candidates.length,
        copiaLastNameCount: eligible.length,
        salesforceUsernameCount,
        ambiguousCount,
        targetedCount: targets.length,
        updatedCount,
        writeCapReached,
        errors,
    };
    logger.log('Copia read-sync marker backfill summary:');
    logger.log(`  Mode: ${options.apply ? 'APPLY' : 'DRY RUN'}`);
    logger.log(`  Scanned Cases: ${result.scannedCount}`);
    logger.log(`  Copia last-name Cases: ${result.copiaLastNameCount}`);
    logger.log(`  CS usernames skipped: ${result.salesforceUsernameCount}`);
    logger.log(`  Ambiguous values skipped: ${result.ambiguousCount}`);
    logger.log(`  ${options.apply ? 'Updated' : 'Would update'}: ${result.targetedCount}`);
    if (writeCapReached) logger.log('  Write cap reached; remaining Copia last-name Cases were not selected.');
    if (errors.length > 0) logger.log(`  Errors: ${errors.length}`);
    return result;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        console.log(COPIA_READ_SYNC_BACKFILL_USAGE);
        return;
    }

    const options = parseCopiaReadSyncBackfillOptions(args);
    const salesforce = new SalesforceHoldClient(getSalesforceConfig());
    await salesforce.login();
    const result = await runCopiaReadSyncBackfill(options, { salesforce });
    if (result.errors.length > 0) process.exitCode = 1;
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Copia read-sync marker backfill failed:', err);
        process.exitCode = 1;
    });
}
