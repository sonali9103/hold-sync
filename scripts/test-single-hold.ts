/**
 * v1.0.1 — test one hold record at a time, end to end.
 *
 * Usage:
 *   npx ts-node scripts/test-single-hold.ts --hold <U_DDIHOLDLISTID>
 *   npx ts-node scripts/test-single-hold.ts --submission <U_SUBMISSIONID>
 *
 * --hold fetches exactly one row. --submission fetches every hold on
 * that submission, which is the right way to test the multi-hold
 * grouping logic (e.g. --submission 260908-2057, a known real
 * submission with two CS holds that resolved together).
 *
 * This intentionally does NOT touch the watermark or run against a
 * date range — it's a scalpel for verifying one record's behavior
 * end to end (Oracle read → transform → Salesforce upsert) before
 * trusting the batch script in src/sync.ts against a whole day's data.
 */
import { getConfig } from '../src/config';
import { OracleHoldClient } from '../src/services/oracle-client';
import { SalesforceHoldClient } from '../src/services/salesforce-client';
import { transformHolds } from '../src/transform';

function parseArgs(): { mode: 'hold' | 'submission'; id: string } {
    const args = process.argv.slice(2);
    const holdIdx = args.indexOf('--hold');
    const subIdx = args.indexOf('--submission');

    if (holdIdx !== -1 && args[holdIdx + 1]) {
        return { mode: 'hold', id: args[holdIdx + 1] };
    }
    if (subIdx !== -1 && args[subIdx + 1]) {
        return { mode: 'submission', id: args[subIdx + 1] };
    }
    throw new Error(
        'Usage: test-single-hold.ts --hold <U_DDIHOLDLISTID>  OR  --submission <U_SUBMISSIONID>'
    );
}

async function main() {
    const { mode, id } = parseArgs();
    const config = getConfig();

    const oracle = new OracleHoldClient(config.oracle);
    await oracle.connect();

    const sf = new SalesforceHoldClient(config.salesforce);
    await sf.login();

    try {
        const rows =
            mode === 'hold'
                ? await (async () => {
                    const row = await oracle.fetchHoldById(id);
                    return row ? [row] : [];
                })()
                : await oracle.fetchHoldsBySubmissionId(id);

        if (rows.length === 0) {
            console.log(`No rows found for ${mode} = ${id}. Nothing to sync.`);
            return;
        }

        console.log(`--- Fetched ${rows.length} row(s) from Oracle ---`);
        for (const row of rows) {
            console.log(
                `  ${row.U_DDIHOLDLISTID} | ${row.U_HOLDCODE} (ID ${row.U_HOLDCODEID}) | ` +
                `submission ${row.U_SUBMISSIONID} | ` +
                `${row.U_OUTDATE ? `resolved ${row.U_OUTDATE.toDateString()}` : 'still open'}`
            );
        }

        const submissionIds = [...new Set(rows.map((r) => r.U_SUBMISSIONID))];
        const subAccountMap = await oracle.fetchSubmissionSubAccountIds(submissionIds);
        const contactInfoMap = await oracle.fetchSubmissionContactInfo(submissionIds);
        console.log(`--- Resolved ${subAccountMap.size} submission → subaccount mapping(s) ---`);

        const tickets = transformHolds(rows, subAccountMap, contactInfoMap);
        console.log(`--- Transformed into ${tickets.length} hold ticket(s) ---`);
        for (const ticket of tickets) {
            console.log(
                `  Hold ${ticket.externalId}: submissionId=${ticket.submissionId}, ` +
                `doctorId=${ticket.doctorId}, subAccountId=${ticket.subAccountId}, ` +
                `${ticket.holdType} (${ticket.isResolved ? 'Resolved' : 'New'})`
            );
        }

        console.log('--- Writing to Salesforce ---');
        for (const ticket of tickets) {
            await sf.upsertTicket(ticket);
            console.log(`  Upserted Case for hold ${ticket.externalId}`);
        }

        console.log('Done. Go check the record(s) in Salesforce before trusting this against a batch.');
    } finally {
        await oracle.close();
    }
}

main().catch((err) => {
    console.error('Test run failed:', err);
    process.exit(1);
});
