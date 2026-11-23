import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CopiaRelease,
    CopiaReleaseOutcome,
    CopiaReleaseResult,
    parseCopiaDryRunDetails,
} from '../src/services/copia-release-client';
import {
    CopiaReleaseApiClient,
    CopiaReleaseSalesforceClient,
    COPIA_RELEASE_REASON,
    parseSfToCopiaOptions,
    runSfToCopia,
} from '../src/sf-to-copia';
import { createCopiaStaffMap } from '../src/copia-staff-map';
import { ResolvedCopiaCasePendingRelease } from '../src/services/salesforce-client';

const STAFF_MAP = createCopiaStaffMap({
    SOTO: 'DDI_ACCT013125',
    YSOTO: 'DDI_ACCT013125',
    BREUER: 'DDI_CST65',
});

function pendingCase(
    suffix: number,
    overrides: Partial<ResolvedCopiaCasePendingRelease> = {}
): ResolvedCopiaCasePendingRelease {
    const holdId = `123456${String(suffix).padStart(2, '0')}`;
    return {
        caseId: `case-${holdId}`,
        caseNumber: `000${suffix}`,
        holdId,
        resolvedBy: 'ysoto',
        ...overrides,
    };
}

class FakeSalesforce implements CopiaReleaseSalesforceClient {
    readonly recorded: Array<{ caseId: string; note: string }> = [];
    receivedOnlyHoldIds: string[] | undefined;

    constructor(private pending: ResolvedCopiaCasePendingRelease[]) { }

    async getResolvedCopiaCasesPendingRelease(
        onlyHoldIds?: string[]
    ): Promise<ResolvedCopiaCasePendingRelease[]> {
        this.receivedOnlyHoldIds = onlyHoldIds;
        return this.pending;
    }

    async recordCopiaReleaseResult(caseId: string, note: string): Promise<void> {
        this.recorded.push({ caseId, note });
    }
}

class FakeCopia implements CopiaReleaseApiClient {
    readonly calls: Array<{ releases: CopiaRelease[]; apply: boolean }> = [];

    constructor(private outcomeFor: (release: CopiaRelease, apply: boolean) => CopiaReleaseResult) { }

    async releaseChunk(releases: CopiaRelease[], apply: boolean): Promise<{ Results: CopiaReleaseResult[] }> {
        this.calls.push({ releases, apply });
        return { Results: releases.map((release) => this.outcomeFor(release, apply)) };
    }
}

test('--apply refuses to run without a Dev hold allow-list', () => {
    assert.throws(
        () => parseSfToCopiaOptions(['--apply']),
        /--only-hold-ids is required/
    );
    assert.deepEqual(
        parseSfToCopiaOptions(['--apply', '--only-hold-ids', '12345678']),
        {
            apply: true,
            apiDryRun: false,
            onlyHoldIds: ['12345678'],
            limit: undefined,
            maxWrites: 25,
        }
    );
});

test('requires bare eight-digit Copia IDs', () => {
    assert.throws(
        () => parseSfToCopiaOptions(['--only-hold-ids', 'COPIA-12345678']),
        /Usage: sf-to-copia/
    );
    assert.throws(
        () => parseSfToCopiaOptions(['--only-hold-ids', '1234567']),
        /Usage: sf-to-copia/
    );
});

test('uses the one Copia release-reason constant, never Case Description', () => {
    assert.equal(COPIA_RELEASE_REASON, 'released');
});

test('mapped Resolved By value is translated to the exact Copia Staff.ID', async () => {
    const salesforce = new FakeSalesforce([pendingCase(1)]);
    const copia = new FakeCopia((release) => ({
        OrderedPanelKey: release.OrderedPanelKey,
        Outcome: 'AlreadyReleased',
        Message: 'already released',
    }));

    await runSfToCopia(parseSfToCopiaOptions([]), {
        salesforce,
        copia,
        staffMap: STAFF_MAP,
        logger: { log: () => undefined },
    });

    assert.equal(copia.calls.length, 1);
    assert.equal(copia.calls[0].releases[0].ResolvedBy, 'DDI_ACCT013125');
});

test('staff-map lookup accepts mixed-case and whitespace CS usernames', async () => {
    const salesforce = new FakeSalesforce([
        pendingCase(1, { resolvedBy: 'ySoTo' }),
        pendingCase(2, { resolvedBy: '  ysoto  ' }),
    ]);
    const copia = new FakeCopia((release) => ({
        OrderedPanelKey: release.OrderedPanelKey,
        Outcome: 'AlreadyReleased',
        Message: 'already released',
    }));

    await runSfToCopia(parseSfToCopiaOptions([]), {
        salesforce,
        copia,
        staffMap: STAFF_MAP,
        logger: { log: () => undefined },
    });

    assert.deepEqual(copia.calls[0].releases.map((release) => release.ResolvedBy), [
        'DDI_ACCT013125',
        'DDI_ACCT013125',
    ]);
});

test('unmapped Case is rejected, makes no network call, and later mapped Case still runs', async () => {
    const salesforce = new FakeSalesforce([
        pendingCase(1, { resolvedBy: 'Unknown' }),
        pendingCase(2, { resolvedBy: '  ysoto  ' }),
    ]);
    const copia = new FakeCopia((release) => ({
        OrderedPanelKey: release.OrderedPanelKey,
        Outcome: 'AlreadyReleased',
        Message: 'already released',
    }));

    const result = await runSfToCopia(parseSfToCopiaOptions([]), {
        salesforce,
        copia,
        staffMap: STAFF_MAP,
        logger: { log: () => undefined },
    });

    assert.equal(result.counts.Rejected, 1);
    assert.deepEqual(result.failedCaseNumbers, ['0001']);
    assert.deepEqual(result.dryRunRows[0], {
        CaseNumber: '0001',
        HoldId: '12345601',
        SourceResolvedBy: 'Unknown',
        CopiaStaffId: null,
        StaffKey: null,
        Reason: 'released',
        ChangeLogMessage: null,
        Outcome: 'Rejected',
        Message: 'No Copia staff mapping for Unknown',
    });
    assert.equal(copia.calls.length, 1);
    assert.deepEqual(copia.calls[0].releases.map((release) => release.OrderedPanelKey), [12345602]);
});

test('an unmapped Case by itself never calls the Copia API', async () => {
    const salesforce = new FakeSalesforce([pendingCase(1, { resolvedBy: 'Unknown' })]);
    const copia = new FakeCopia(() => {
        throw new Error('Copia API must not be called for an unmapped Case');
    });

    const result = await runSfToCopia(parseSfToCopiaOptions([]), {
        salesforce,
        copia,
        staffMap: STAFF_MAP,
        logger: { log: () => undefined },
    });

    assert.equal(result.counts.Rejected, 1);
    assert.equal(copia.calls.length, 0);
});

test('dry run makes no Salesforce write and prints staff, reason, and exact ChangeLog message', async () => {
    const salesforce = new FakeSalesforce([pendingCase(1)]);
    const changeLogMessage =
        '112_Cancelled By modified [-1]->[77] cancelledStamp modified [ ] -> [03/09/2025 3:01:02 AM] ' +
        'cancelReason modified [ ]->[released] isCancelled modified [false]->[true]';
    const copia = new FakeCopia((release, apply) => {
        assert.equal(apply, false);
        return {
            OrderedPanelKey: release.OrderedPanelKey,
            Outcome: 'WouldUpdate',
            Message: `StaffKey=77; ChangeLogMessage=${changeLogMessage}`,
        };
    });
    const logs: string[] = [];

    const result = await runSfToCopia(parseSfToCopiaOptions([]), {
        salesforce,
        copia,
        staffMap: STAFF_MAP,
        logger: { log: (line) => logs.push(line) },
    });

    assert.equal(salesforce.recorded.length, 0);
    assert.equal(copia.calls.length, 1);
    assert.deepEqual(copia.calls[0].releases[0], {
        OrderedPanelKey: 12345601,
        ResolvedBy: 'DDI_ACCT013125',
        Reason: 'released',
    });
    assert.deepEqual(result.dryRunRows[0], {
        CaseNumber: '0001',
        HoldId: '12345601',
        SourceResolvedBy: 'ysoto',
        CopiaStaffId: 'DDI_ACCT013125',
        StaffKey: 77,
        Reason: 'released',
        ChangeLogMessage: changeLogMessage,
        Outcome: 'WouldUpdate',
        Message: `StaffKey=77; ChangeLogMessage=${changeLogMessage}`,
    });
    assert.ok(logs.includes(`  ChangeLog message: ${changeLogMessage}`));
});

test('accounts for every Copia endpoint outcome in dry-run mode', async () => {
    const outcomes: CopiaReleaseOutcome[] = [
        'Updated', 'WouldUpdate', 'AlreadyReleased', 'Changed', 'NotFound', 'Rejected', 'Error',
    ];
    const salesforce = new FakeSalesforce(outcomes.map((_, index) => pendingCase(index + 1)));
    const copia = new FakeCopia((release) => ({
        OrderedPanelKey: release.OrderedPanelKey,
        Outcome: outcomes[release.OrderedPanelKey - 12345601],
        Message: 'endpoint result',
    }));

    const result = await runSfToCopia(parseSfToCopiaOptions([]), {
        salesforce,
        copia,
        staffMap: STAFF_MAP,
        logger: { log: () => undefined },
    });

    for (const outcome of outcomes) assert.equal(result.counts[outcome], 1);
    assert.equal(result.hasError, true);
    assert.equal(salesforce.recorded.length, 0);
});

test('apply records only Updated and AlreadyReleased Salesforce Cases', async () => {
    const salesforce = new FakeSalesforce([pendingCase(1), pendingCase(2), pendingCase(3)]);
    const outcomes: CopiaReleaseOutcome[] = ['Updated', 'AlreadyReleased', 'Rejected'];
    const copia = new FakeCopia((release) => ({
        OrderedPanelKey: release.OrderedPanelKey,
        Outcome: outcomes[release.OrderedPanelKey - 12345601],
        Message: 'endpoint result',
    }));

    const result = await runSfToCopia(
        parseSfToCopiaOptions(['--apply', '--only-hold-ids', '12345601,12345602,12345603']),
        { salesforce, copia, staffMap: STAFF_MAP, logger: { log: () => undefined } }
    );

    assert.equal(copia.calls[0].apply, true);
    assert.deepEqual(salesforce.recorded.map((item) => item.caseId), [
        'case-12345601',
        'case-12345602',
    ]);
    assert.equal(result.counts.Rejected, 1);
});

test('apply obeys the Copia write cap before calling the API', async () => {
    const salesforce = new FakeSalesforce([pendingCase(1), pendingCase(2), pendingCase(3)]);
    const copia = new FakeCopia((release) => ({
        OrderedPanelKey: release.OrderedPanelKey,
        Outcome: 'Updated',
        Message: 'updated',
    }));

    const result = await runSfToCopia(
        parseSfToCopiaOptions([
            '--apply', '--only-hold-ids', '12345601,12345602,12345603', '--max-writes', '2',
        ]),
        { salesforce, copia, staffMap: STAFF_MAP, logger: { log: () => undefined } }
    );

    assert.equal(result.writeCapReached, true);
    assert.equal(result.attemptedCount, 2);
    assert.equal(copia.calls[0].releases.length, 2);
    assert.equal(salesforce.recorded.length, 2);
});

test('parses the full raw ChangeLog message without changing its DST-sensitive timestamp', () => {
    const message =
        'StaffKey=9; ChangeLogMessage=112_Cancelled By modified [-1]->[9] ' +
        'cancelledStamp modified [ ] -> [11/02/2025 1:30:00 AM] ' +
        'cancelReason modified [ ]->[released] isCancelled modified [false]->[true]';
    assert.deepEqual(parseCopiaDryRunDetails(message), {
        staffKey: 9,
        changeLogMessage: message.slice('StaffKey=9; ChangeLogMessage='.length),
    });
});
