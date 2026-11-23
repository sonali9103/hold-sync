import { CopiaStaffMap, findCopiaStaffId, normalizeCopiaStaffMapKey, loadCopiaStaffMap } from './copia-staff-map';
import { getSalesforceConfig } from './config';
import { SalesforceHoldClient } from './services/salesforce-client';

export interface CopiaResolvedBySource {
    getResolvedCopiaCaseResolvedByValues(): Promise<Array<string | null>>;
}

/**
 * Returns canonical, distinct map keys rather than using a person-name lookup.  `(blank)` calls
 * out Cases which must be corrected before they can ever be released to Copia.
 */
export function findUnmappedCopiaResolvedByValues(
    values: Array<string | null>,
    staffMap: CopiaStaffMap
): string[] {
    const unmapped = new Set<string>();
    for (const value of values) {
        const mapping = findCopiaStaffId(staffMap, value);
        if (!mapping.staffId) {
            unmapped.add(normalizeCopiaStaffMapKey(value) || '(blank)');
        }
    }
    return [...unmapped].sort((left, right) => left.localeCompare(right));
}

export async function runCopiaUnmappedStaff(
    dependencies: {
        salesforce: CopiaResolvedBySource;
        staffMap: CopiaStaffMap;
        logger?: { log(message: string): void };
    }
): Promise<string[]> {
    const values = await dependencies.salesforce.getResolvedCopiaCaseResolvedByValues();
    const unmapped = findUnmappedCopiaResolvedByValues(values, dependencies.staffMap);
    const logger = dependencies.logger || console;
    logger.log(`Unmapped Resolved_By__c values (${unmapped.length}):`);
    for (const value of unmapped) logger.log(`  ${value}`);
    return unmapped;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        console.log('Usage: copia-unmapped-staff\nLists canonical Resolved_By__c values on all Resolved Copia Cases missing from copia-staff-map.json.');
        return;
    }
    if (args.length > 0) {
        throw new Error('Usage: copia-unmapped-staff');
    }

    const salesforce = new SalesforceHoldClient(getSalesforceConfig());
    const staffMap = loadCopiaStaffMap();
    await salesforce.login();
    await runCopiaUnmappedStaff({ salesforce, staffMap });
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Copia unmapped-staff report failed:', err);
        process.exitCode = 1;
    });
}
