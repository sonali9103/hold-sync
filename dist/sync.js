"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const copia_client_1 = require("./services/copia-client");
const oracle_client_1 = require("./services/oracle-client");
const salesforce_client_1 = require("./services/salesforce-client");
const transform_1 = require("./transform");
const watermark_1 = require("./watermark");
function getSinceDateOverride() {
    const args = process.argv.slice(2);
    const sinceIdx = args.indexOf('--since');
    if (sinceIdx === -1)
        return null;
    const sinceDate = args[sinceIdx + 1];
    if (!(0, watermark_1.isValidWatermarkDate)(sinceDate)) {
        throw new Error('Usage: sync.ts --since <DD-MON-YYYY>');
    }
    return sinceDate;
}
function getOptions() {
    const args = process.argv.slice(2);
    const sourceIdx = args.indexOf('--source');
    const source = sourceIdx === -1 ? 'sapphire' : args[sourceIdx + 1];
    if (source !== 'sapphire' && source !== 'copia' && source !== 'all') {
        throw new Error('Usage: sync.ts --source sapphire|copia|all');
    }
    const backfillOpen = args.includes('--backfill-open');
    if (backfillOpen && source === 'sapphire') {
        throw new Error('--backfill-open is only valid with --source copia or all');
    }
    return {
        source,
        sinceDateOverride: getSinceDateOverride(),
        backfillOpen,
    };
}
async function runSapphire(config, sf, login, sinceDateOverride) {
    const newWatermark = (0, watermark_1.formatWatermarkDate)(new Date());
    const localWatermark = sinceDateOverride ? null : (0, watermark_1.readWatermark)();
    const oracle = new oracle_client_1.OracleHoldClient(config.oracle);
    await oracle.connect();
    await login();
    let sinceDate;
    if (sinceDateOverride) {
        sinceDate = sinceDateOverride;
        console.log(`Manual sync run — reading changes since ${sinceDate} (from --since override)`);
    }
    else if (localWatermark) {
        sinceDate = localWatermark;
        console.log(`Manual sync run — reading changes since ${sinceDate} (from local watermark file)`);
    }
    else {
        const salesforceWatermark = await sf.getLatestSyncedHoldDate();
        if (!salesforceWatermark) {
            throw new Error('No sync watermark exists: the local watermark file is missing and Salesforce has no synced Cases with a hold creation date. This first-ever run requires --since <DD-MON-YYYY>.');
        }
        sinceDate = salesforceWatermark;
        console.log(`Manual sync run — reading changes since ${sinceDate} (from Salesforce's own last-synced hold)`);
    }
    try {
        const changedHoldRows = await oracle.fetchChangedHolds(sinceDate);
        console.log(`Fetched ${changedHoldRows.length} changed hold rows`);
        const submissionIds = [
            ...new Set(changedHoldRows.map((row) => row.U_SUBMISSIONID)),
        ];
        const subAccountMap = await oracle.fetchSubmissionSubAccountIds(submissionIds);
        const contactInfoMap = await oracle.fetchSubmissionContactInfo(submissionIds);
        const tickets = (0, transform_1.transformHolds)(changedHoldRows, subAccountMap, contactInfoMap);
        console.log(`Transformed into ${tickets.length} hold ticket(s)`);
        for (const ticket of tickets) {
            await sf.upsertTicket(ticket);
            console.log(`Upserted Case for hold ${ticket.externalId}`);
        }
    }
    finally {
        await oracle.close();
    }
    (0, watermark_1.writeWatermark)(newWatermark);
    console.log('Manual sync run complete.');
}
async function runCopia(config, sf, login, sinceDateOverride, backfillOpen) {
    const newWatermark = (0, watermark_1.formatUtcWatermarkDate)(new Date());
    const copia = new copia_client_1.CopiaHoldClient(config.copia);
    await login();
    let sinceDate;
    if (backfillOpen) {
        sinceDate = null;
        console.log('[copia] Manual sync run — reading every currently open hold (from --backfill-open)');
    }
    else if (sinceDateOverride) {
        sinceDate = sinceDateOverride;
        console.log(`[copia] Manual sync run — reading changes since ${sinceDate} (from --since override)`);
    }
    else {
        const localWatermark = (0, watermark_1.readWatermark)('copia');
        if (localWatermark) {
            sinceDate = localWatermark;
            console.log(`[copia] Manual sync run — reading changes since ${sinceDate} (from local watermark file)`);
        }
        else {
            const salesforceWatermark = await sf.getLatestSyncedHoldDate('copia');
            if (!salesforceWatermark) {
                throw new Error('No Copia sync watermark exists: the local Copia watermark file is missing and Salesforce has no synced Copia Cases with a hold creation date. This first-ever Copia run requires --since <DD-MON-YYYY>.');
            }
            sinceDate = salesforceWatermark;
            console.log(`[copia] Manual sync run — reading changes since ${sinceDate} (from Salesforce's own last-synced Copia hold)`);
        }
    }
    const changedHoldRows = await copia.fetchChangedHolds(sinceDate, backfillOpen);
    console.log(`[copia] Fetched ${changedHoldRows.length} changed hold rows`);
    const tickets = (0, transform_1.transformCopiaHolds)(changedHoldRows);
    console.log(`[copia] Transformed into ${tickets.length} hold ticket(s)`);
    for (const ticket of tickets) {
        await sf.upsertTicket(ticket);
        console.log(`[copia] Upserted Case for hold ${ticket.externalId}`);
    }
    (0, watermark_1.writeWatermark)(newWatermark, 'copia');
    console.log('[copia] Manual sync run complete.');
}
async function main() {
    const options = getOptions();
    const config = (0, config_1.getConfig)();
    const sf = new salesforce_client_1.SalesforceHoldClient(config.salesforce);
    let loginPromise = null;
    const login = () => {
        loginPromise ?? (loginPromise = sf.login());
        return loginPromise;
    };
    if (options.source === 'sapphire') {
        await runSapphire(config, sf, login, options.sinceDateOverride);
        return;
    }
    if (options.source === 'copia') {
        try {
            await runCopia(config, sf, login, options.sinceDateOverride, options.backfillOpen);
        }
        catch (err) {
            console.error('[copia] Sync run failed:', err);
            process.exitCode = 1;
        }
        return;
    }
    let failed = false;
    try {
        await runSapphire(config, sf, login, options.sinceDateOverride);
    }
    catch (err) {
        console.error('Sync run failed:', err);
        failed = true;
    }
    try {
        await runCopia(config, sf, login, options.sinceDateOverride, options.backfillOpen);
    }
    catch (err) {
        console.error('[copia] Sync run failed:', err);
        failed = true;
    }
    if (failed)
        process.exitCode = 1;
}
main().catch((err) => {
    console.error('Sync run failed:', err);
    process.exit(1);
});
