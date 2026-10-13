"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.transformHolds = transformHolds;
exports.transformCopiaHolds = transformCopiaHolds;
const crosswalk_1 = require("./crosswalk");
/** Maps each Sapphire hold directly to one standalone Salesforce Case. */
function transformHolds(rows, subAccountIdBySubmission, contactInfoBySubmission) {
    return rows.map((row) => {
        const contactInfo = contactInfoBySubmission.get(row.U_SUBMISSIONID);
        return {
            externalId: row.U_DDIHOLDLISTID,
            submissionId: row.U_SUBMISSIONID,
            doctorId: row.U_DOCTORID,
            subAccountId: subAccountIdBySubmission.get(row.U_SUBMISSIONID) ?? null,
            doctorName: contactInfo?.doctorName ?? null,
            doctorPhone: contactInfo?.doctorPhone ?? null,
            patientName: contactInfo?.patientName ?? null,
            patientPhone: contactInfo?.patientPhone ?? null,
            holdSource: 'Sapphire',
            patientId: contactInfo?.patientId ?? null,
            holdType: (0, crosswalk_1.canonicalHoldType)(row.U_HOLDCODEID, row.U_HOLDCODE),
            // Hold-level NOTES was populated in 0 of 840 sampled real holds over 30 days; CS commentary lives in SUBMISSION.NOTES.
            notes: row.submissionNotes,
            sourceTool: row.CREATETOOL,
            createdBy: row.CREATEBY,
            createdDate: row.CREATEDT,
            isResolved: row.U_OUTDATE !== null,
            resolvedBy: row.U_HOLDRELEASEDBY,
            resolvedDate: row.U_OUTDATE,
        };
    });
}
function joinName(firstName, lastName) {
    const name = [firstName, lastName].filter((part) => part).join(' ');
    return name || null;
}
/** Maps each Copia hold directly to one standalone Salesforce Case. */
function transformCopiaHolds(rows) {
    return rows.map((row) => {
        let notes = row.commentText;
        if (row.isCancelled && row.cancelReason?.trim()) {
            notes = `${notes ?? ''}\n[Released] ${row.cancelReason}`;
        }
        return {
            // Sapphire hold IDs and Copia orderedPanelKey values overlap, so COPIA- prevents external-ID collisions.
            externalId: `${row.orderedPanelKey}`,
            submissionId: row.requisitionNumber,
            doctorId: row.accountId,
            // Copia has no per-order Contact; ClientServiceClientContact has no requisition link.
            subAccountId: null,
            doctorName: joinName(row.providerFirstName, row.providerLastName),
            doctorPhone: row.practicePhone,
            patientName: joinName(row.patientFirstName, row.patientLastName),
            patientPhone: row.patientPhone,
            holdSource: 'Copia',
            patientId: row.patientId || null,
            holdType: row.holdName,
            notes,
            sourceTool: 'Copia',
            createdBy: '',
            createdDate: row.createdUtc,
            isResolved: row.isCancelled,
            // Computed but currently unused: upsertTicket() omits it, as it does for Sapphire today.
            resolvedBy: row.releasedByLastName,
            resolvedDate: row.cancelledUtc,
        };
    });
}
