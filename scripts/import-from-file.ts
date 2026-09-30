/**
 * Pragmatic v1.0.1 fallback: instead of Node driving sqlplus directly
 * (which has been fighting Windows process-spawning all session —
 * ENOBUFS, then silent hangs), YOU run the query manually in your
 * already-proven-reliable SQL*Plus session, spool it to a file, and
 * this script just reads that file and pushes it through transform +
 * Salesforce upsert.
 *
 * Step 1 — in SQL*Plus, run (now includes doctor/patient contact info,
 * joined via SUBMISSION -> U_DOCTOR / U_PATIENT, with graceful blank
 * fallback via outer joins if a doctor/patient record is missing):
 *
 *   SET LINESIZE 32000
 *   SET PAGESIZE 0
 *   SET FEEDBACK OFF
 *   SET HEADING OFF
 *   SET TRIMSPOOL ON
 *   SET ECHO OFF
 *   SPOOL C:\Temp\hold_export.txt
 *   SELECT h.U_DDIHOLDLISTID ||'|'|| h.U_SUBMISSIONID ||'|'|| h.U_HOLDCODE ||'|'|| h.U_HOLDCODEID ||'|'
 *     || NVL(h.NOTES,'') ||'|'|| h.CREATEDT ||'|'|| h.CREATEBY ||'|'|| h.CREATETOOL ||'|'
 *     || NVL(TO_CHAR(h.U_OUTDATE),'') ||'|'|| NVL(h.U_HOLDRELEASEDBY,'') ||'|'|| NVL(h.U_DOCTORID,'') ||'|'
 *     || NVL(TRIM(d.FIRSTNAME ||' '|| d.LASTNAME),'') ||'|'|| NVL(d.OFFICEPHONE,'') ||'|'
 *     || NVL(TRIM(p.FIRSTNAME ||' '|| p.LASTNAME),'') ||'|'|| NVL(p.PHONE,'')
 *   FROM U_DDIHOLDLIST h, SUBMISSION s, U_DOCTOR d, U_PATIENT p
 *   WHERE h.U_SUBMISSIONID = '260908-2057'
 *     AND s.SUBMISSIONID (+) = h.U_SUBMISSIONID
 *     AND d.U_DOCTORID (+) = s.U_DOCTORID
 *     AND p.U_PATIENTID (+) = s.U_PATIENTID;
 *   SPOOL OFF
 *
 * Step 2 — run this script pointing at that file:
 *   node -r ts-node/register scripts/import-from-file.ts C:\Temp\hold_export.txt
 *
 * Column order per line (15 total, pipe-delimited):
 *   U_DDIHOLDLISTID | U_SUBMISSIONID | U_HOLDCODE | U_HOLDCODEID | NOTES |
 *   CREATEDT | CREATEBY | CREATETOOL | U_OUTDATE | U_HOLDRELEASEDBY |
 *   U_DOCTORID | DOCTOR_NAME | DOCTOR_PHONE | PATIENT_NAME | PATIENT_PHONE
 */
import { getConfig } from '../src/config';
import { HoldRow, SubmissionContactInfo } from '../src/services/oracle-client';
import { SalesforceHoldClient } from '../src/services/salesforce-client';
import { transformHolds } from '../src/transform';
import * as fs from 'fs';

// Duplicated from oracle-client.ts's private parser — small enough
// not to worry about sharing, and keeps this script standalone.
function parseOracleDate(value: string): Date | null {
    if (!value) return null;
    const parsed = new Date(value.replace(/-/g, ' '));
    return isNaN(parsed.getTime()) ? null : parsed;
}

interface ParsedLine {
    hold: HoldRow;
    contactInfo: SubmissionContactInfo;
}

function parseHoldRowLine(line: string): ParsedLine {
    const [
        id, submissionId, holdCode, holdCodeId, notes,
        createdt, createby, createtool, outdate, releasedby, doctorid,
        doctorName, doctorPhone, patientName, patientPhone,
    ] = line.split('|');

    return {
        hold: {
            U_DDIHOLDLISTID: id,
            U_SUBMISSIONID: submissionId,
            U_HOLDCODE: holdCode,
            U_HOLDCODEID: Number(holdCodeId),
            NOTES: notes || null,
            CREATEDT: parseOracleDate(createdt) as Date,
            CREATEBY: createby,
            CREATETOOL: createtool,
            U_OUTDATE: parseOracleDate(outdate),
            U_HOLDRELEASEDBY: releasedby || null,
            U_DOCTORID: doctorid || null,
        },
        contactInfo: {
            doctorName: doctorName || null,
            doctorPhone: doctorPhone || null,
            patientName: patientName || null,
            patientPhone: patientPhone || null,
        },
    };
}

async function main() {
    const filePath = process.argv[2];
    if (!filePath) {
        throw new Error('Usage: import-from-file.ts <path-to-spooled-file>');
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

    console.log(`Read ${lines.length} line(s) from ${filePath}`);
    const parsed = lines.map(parseHoldRowLine);
    const rows = parsed.map((p) => p.hold);

    for (const row of rows) {
        console.log(
            `  ${row.U_DDIHOLDLISTID} | ${row.U_HOLDCODE} (ID ${row.U_HOLDCODEID}) | ` +
            `submission ${row.U_SUBMISSIONID} | ` +
            `${row.U_OUTDATE ? `resolved ${row.U_OUTDATE.toDateString()}` : 'still open'}`
        );
    }

    // Build the contact-info map from the spool file itself, keyed by
    // submission ID — same shape oracle-client.ts's
    // fetchSubmissionContactInfo() produces, just sourced from the
    // manually-spooled file instead of a live query. If a submission
    // has multiple hold rows, they all carry the same contact info, so
    // the last one parsed just overwrites with an identical value.
    const contactInfoMap = new Map<string, SubmissionContactInfo>();
    for (const p of parsed) {
        contactInfoMap.set(p.hold.U_SUBMISSIONID, p.contactInfo);
        console.log(
            `  contact info for ${p.hold.U_SUBMISSIONID}: ` +
            `doctor="${p.contactInfo.doctorName ?? '(none)'}" ` +
            `(${p.contactInfo.doctorPhone ?? 'no phone'}), ` +
            `patient="${p.contactInfo.patientName ?? '(none)'}" ` +
            `(${p.contactInfo.patientPhone ?? 'no phone'})`
        );
    }

    const config = getConfig();
    const sf = new SalesforceHoldClient(config.salesforce);
    await sf.login();

    // No SUBMISSION join for Contact resolution in this fallback path —
    // subAccountId will still be blank. Fine for now; contact info
    // above is separate from Salesforce Contact resolution.
    const subAccountMap = new Map<string, string | null>();
    const tickets = transformHolds(rows, subAccountMap, contactInfoMap);

    console.log(`Transformed into ${tickets.length} hold ticket(s)`);
    for (const ticket of tickets) {
        await sf.upsertTicket(ticket);
        console.log(
            `Upserted Case for hold ${ticket.externalId} ` +
            `(submission ${ticket.submissionId})`
        );
    }

    console.log('Done. Go check the record(s) in Salesforce.');
}

main().catch((err) => {
    console.error('Import failed:', err);
    process.exit(1);
});
