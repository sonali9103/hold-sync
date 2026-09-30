/**
 * Standalone DDIVbNetApis connection check -- run this BEFORE
 * test-single-hold.ts. Confirms the configured REST API can read
 * Sapphire hold data.
 *
 * Usage: npx ts-node scripts/check-oracle-connection.ts
 */
import { getConfig } from '../src/config';
import { OracleHoldClient } from '../src/services/oracle-client';

async function main() {
    const config = getConfig();

    console.log(`Connecting to ${config.oracle.baseUrl}...`);
    const client = new OracleHoldClient(config.oracle);

    // A date far enough back that it should catch real rows, just to
    // prove the round trip works end to end.
    const rows = await client.fetchChangedHolds('01-JAN-2020');
    console.log(`API request succeeded. Fetched ${rows.length} row(s).`);
    if (rows.length > 0) {
        console.log('Sample row:', rows[0]);
    }
}

main().catch((err) => {
    console.error('Connection check FAILED:', err.message);
    process.exit(1);
});
