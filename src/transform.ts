import { HoldRow, SubmissionContactInfo } from './services/oracle-client';
import { CopiaHoldRow } from './services/copia-client';
import { canonicalHoldType } from './crosswalk';

export interface HoldTicketRecord {
  externalId: string;       // U_DDIHOLDLISTID
  submissionId: string;     // U_SUBMISSIONID
  doctorId: string | null;  // -> Account.Name
  subAccountId: string | null; // -> Contact.SubAccountId__c
  // Synced independently as-is; any one of these fields may be null.
  doctorName: string | null;
  doctorPhone: string | null;
  patientName: string | null;
  patientPhone: string | null;
  holdSource: 'Sapphire' | 'Copia';
  patientId: string | null;
  holdType: string;
  notes: string | null;
  sourceTool: string;
  createdBy: string;
  createdDate: Date;
  isResolved: boolean;
  resolvedBy: string | null;
  resolvedDate: Date | null;
}

/** Maps each Sapphire hold directly to one standalone Salesforce Case. */
export function transformHolds(
  rows: HoldRow[],
  subAccountIdBySubmission: Map<string, string | null>,
  contactInfoBySubmission: Map<string, SubmissionContactInfo>
): HoldTicketRecord[] {
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
      holdType: canonicalHoldType(row.U_HOLDCODEID, row.U_HOLDCODE),
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

function joinName(firstName: string | null, lastName: string | null): string | null {
  const name = [firstName, lastName].filter((part) => part).join(' ');
  return name || null;
}

/** Maps each Copia hold directly to one standalone Salesforce Case. */
export function transformCopiaHolds(rows: CopiaHoldRow[]): HoldTicketRecord[] {
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
      createdDate: row.createdUtc as Date,
      isResolved: row.isCancelled,
      // Computed but currently unused: upsertTicket() omits it, as it does for Sapphire today.
      resolvedBy: row.releasedByLastName,
      resolvedDate: row.cancelledUtc,
    };
  });
}
