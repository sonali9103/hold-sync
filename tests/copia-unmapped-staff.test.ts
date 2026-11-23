import assert from 'node:assert/strict';
import test from 'node:test';

import { createCopiaStaffMap } from '../src/copia-staff-map';
import {
    findUnmappedCopiaResolvedByValues,
    runCopiaUnmappedStaff,
} from '../src/copia-unmapped-staff';

test('unmapped-staff report deduplicates normalized Resolved By values', async () => {
    const staffMap = createCopiaStaffMap({ SOTO: 'DDI_ACCT013125' });
    const logs: string[] = [];
    const unmapped = await runCopiaUnmappedStaff({
        salesforce: {
            async getResolvedCopiaCaseResolvedByValues() {
                return [' Soto ', 'sOtO', 'Breuer', '  BREUER  ', null, ''];
            },
        },
        staffMap,
        logger: { log: (line) => logs.push(line) },
    });

    assert.deepEqual(unmapped, ['(blank)', 'BREUER']);
    assert.deepEqual(logs, [
        'Unmapped Resolved_By__c values (2):',
        '  (blank)',
        '  BREUER',
    ]);
});

test('unmapped-staff report has no unmapped values when every normalized key is present', () => {
    const staffMap = createCopiaStaffMap({ SOTO: 'DDI_ACCT013125' });
    assert.deepEqual(
        findUnmappedCopiaResolvedByValues(['SOTO', ' Soto '], staffMap),
        []
    );
});
