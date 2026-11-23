import assert from 'node:assert/strict';
import test from 'node:test';

import {
    classifyCopiaResolvedBy,
    parseCopiaReadSyncBackfillOptions,
    runCopiaReadSyncBackfill,
} from '../src/copia-read-sync-backfill';
import { ResolvedCopiaCaseMissingReleaseSync } from '../src/services/salesforce-client';

class FakeSalesforce {
    readonly marked: string[] = [];

    constructor(private readonly cases: ResolvedCopiaCaseMissingReleaseSync[]) { }

    async getResolvedCopiaCasesMissingReleaseSync(): Promise<ResolvedCopiaCaseMissingReleaseSync[]> {
        return this.cases;
    }

    async markCopiaReadSyncResolved(caseId: string): Promise<void> {
        this.marked.push(caseId);
    }
}

const CASES: ResolvedCopiaCaseMissingReleaseSync[] = [
    { caseId: 'case-1', caseNumber: '0001', resolvedBy: 'Soto' },
    { caseId: 'case-2', caseNumber: '0002', resolvedBy: 'ysoto' },
    { caseId: 'case-3', caseNumber: '0003', resolvedBy: 'BREUER' },
    { caseId: 'case-4', caseNumber: '0004', resolvedBy: null },
];

test('classifies Copia last names conservatively and preserves CS usernames', () => {
    assert.equal(classifyCopiaResolvedBy('Soto'), 'CopiaLastName');
    assert.equal(classifyCopiaResolvedBy('BREUER'), 'CopiaLastName');
    assert.equal(classifyCopiaResolvedBy('ysoto'), 'SalesforceUsername');
    assert.equal(classifyCopiaResolvedBy(''), 'Ambiguous');
    assert.equal(classifyCopiaResolvedBy('1234'), 'Ambiguous');
});

test('backfill defaults to dry run and makes no Salesforce update', async () => {
    const salesforce = new FakeSalesforce(CASES);
    const logs: string[] = [];

    const result = await runCopiaReadSyncBackfill(
        parseCopiaReadSyncBackfillOptions([]),
        { salesforce, logger: { log: (line) => logs.push(line) } }
    );

    assert.deepEqual(salesforce.marked, []);
    assert.equal(result.copiaLastNameCount, 2);
    assert.equal(result.salesforceUsernameCount, 1);
    assert.equal(result.ambiguousCount, 1);
    assert.equal(result.targetedCount, 2);
    assert.ok(logs.includes('Case 0002 | skipped CS username: ysoto'));
    assert.ok(logs.includes('Case 0001 | WouldUpdate | Copia last name: Soto'));
});

test('backfill apply respects the write cap and never marks CS usernames', async () => {
    const salesforce = new FakeSalesforce(CASES);
    const result = await runCopiaReadSyncBackfill(
        parseCopiaReadSyncBackfillOptions(['--apply', '--max-writes', '1']),
        { salesforce, logger: { log: () => undefined } }
    );

    assert.deepEqual(salesforce.marked, ['case-1']);
    assert.equal(result.updatedCount, 1);
    assert.equal(result.writeCapReached, true);
});

test('backfill rejects conflicting modes and invalid caps', () => {
    assert.throws(
        () => parseCopiaReadSyncBackfillOptions(['--apply', '--dry-run']),
        /cannot be used together/
    );
    assert.throws(
        () => parseCopiaReadSyncBackfillOptions(['--max-writes', '0']),
        /Usage: copia-read-sync-backfill/
    );
});
