import assert from 'node:assert/strict';
import test from 'node:test';

import { CopiaHoldRow } from '../src/services/copia-client';
import { transformCopiaHolds } from '../src/transform';

function copiaHold(isCancelled: boolean): CopiaHoldRow {
    return {
        orderedPanelKey: 12345678,
        requisitionNumber: 'req-1',
        labPanelCode: 'HoldBill',
        holdName: 'Billing',
        panelKey: 1,
        createdUtc: new Date('2026-01-01T00:00:00.000Z'),
        isCancelled,
        cancelledUtc: isCancelled ? new Date('2026-01-02T00:00:00.000Z') : null,
        releasedByLastName: isCancelled ? 'Soto' : null,
        cancelReason: isCancelled ? 'released' : null,
        accountId: null,
        practiceName: null,
        practicePhone: null,
        providerFirstName: null,
        providerLastName: null,
        patientId: null,
        patientFirstName: null,
        patientLastName: null,
        patientPhone: null,
        commentText: null,
    };
}

test('Copia cancelled holds are marked source-release-synced, open holds are not', () => {
    const [cancelled, open] = transformCopiaHolds([copiaHold(true), copiaHold(false)]);

    assert.equal(cancelled.isResolved, true);
    assert.equal(cancelled.sourceReleaseSynced, true);
    assert.equal(open.isResolved, false);
    assert.equal(open.sourceReleaseSynced, false);
});
