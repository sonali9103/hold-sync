import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ReleaseSyncSalesforceClient,
    ReleaseSyncSapphireClient,
    runReleaseSync,
} from '../src/release-sync';
import { ResolvedCasePendingRelease } from '../src/services/salesforce-client';
import { SapphireRelease, SapphireReleaseResult } from '../src/services/sapphire-release-client';

class FakeSalesforce implements ReleaseSyncSalesforceClient {
    readonly recorded: Array<{ caseId: string; synced: boolean; note: string | null }> = [];

    constructor(private pending: ResolvedCasePendingRelease[]) { }

    async getResolvedCasesPendingRelease(): Promise<ResolvedCasePendingRelease[]> {
        return this.pending;
    }

    async recordReleaseResult(caseId: string, synced: boolean, note: string | null): Promise<void> {
        this.recorded.push({ caseId, synced, note });
    }
}

class FakeSapphire implements ReleaseSyncSapphireClient {
    readonly calls: Array<{ releases: SapphireRelease[]; dryRun: boolean }> = [];

    async releaseChunk(releases: SapphireRelease[], dryRun: boolean): Promise<{ Results: SapphireReleaseResult[] }> {
        this.calls.push({ releases, dryRun });
        return {
            Results: releases.map((release) => ({
                HoldId: release.HoldId,
                CaseNumber: release.CaseNumber,
                Outcome: dryRun ? 'WouldRelease' : 'Released',
                Message: null,
            })),
        };
    }
}

function pendingCase(
    holdId: string,
    resolvedBy: string | null
): ResolvedCasePendingRelease {
    return {
        caseId: `case-${holdId}`,
        caseNumber: `000${holdId}`,
        holdId,
        resolvedBy,
    };
}

test('uses each Case Resolved_By value after trimming and lowercasing, with fallback for blank values', async () => {
    const salesforce = new FakeSalesforce([
        pendingCase('1', '  TestSonali  '),
        pendingCase('2', '   '),
    ]);
    const sapphire = new FakeSapphire();

    const result = await runReleaseSync(
        { apply: false },
        { salesforce, sapphire, releasedBy: 'sfsync' }
    );

    assert.deepEqual(
        sapphire.calls.flatMap((call) => call.releases).map((release) => ({
            holdId: release.HoldId,
            releasedBy: release.ReleasedBy,
        })),
        [
            { holdId: '1', releasedBy: 'testsonali' },
            { holdId: '2', releasedBy: 'sfsync' },
        ]
    );
    assert.equal(result.counts.WouldRelease, 2);
    assert.deepEqual(
        result.dryRunRows.map((row) => row.ReleasedBy),
        ['testsonali', 'sfsync']
    );
});

test('rejects an overlong Case Resolved_By value without sending that hold to Sapphire', async () => {
    const salesforce = new FakeSalesforce([pendingCase('1', 'A'.repeat(21))]);
    const sapphire = new FakeSapphire();

    const result = await runReleaseSync(
        { apply: false },
        { salesforce, sapphire, releasedBy: 'sfsync' }
    );

    assert.deepEqual(sapphire.calls, []);
    assert.equal(result.counts.Rejected, 1);
    assert.match(result.dryRunRows[0].Message, /21 characters after trimming\/lowercasing/);
    assert.equal(result.hasError, false);
});

test('sends separate request groups for Cases with different normalized released-by users', async () => {
    const salesforce = new FakeSalesforce([
        pendingCase('1', 'Alice'),
        pendingCase('2', 'Bob'),
    ]);
    const sapphire = new FakeSapphire();

    await runReleaseSync(
        { apply: false },
        { salesforce, sapphire, releasedBy: 'sfsync' }
    );

    assert.deepEqual(sapphire.calls.map((call) => call.releases), [
        [{ HoldId: '1', ReleasedBy: 'alice', CaseNumber: '0001' }],
        [{ HoldId: '2', ReleasedBy: 'bob', CaseNumber: '0002' }],
    ]);
});
