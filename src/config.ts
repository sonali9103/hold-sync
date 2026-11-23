import * as dotenv from 'dotenv';
dotenv.config();

function required(name: string): string {
    const val = process.env[name];
    if (!val) throw new Error(`Missing required env var: ${name}`);
    return val;
}

export function getConfig() {
    return {
        oracle: {
            baseUrl: required('DDI_API_BASE_URL'),
            oracleConnectName: process.env.ORACLE_CONNECT_NAME || 'Prod',
        },
        copia: {
            baseUrl: required('DDI_API_BASE_URL'),
            copiaConnectName: process.env.COPIA_CONNECT_NAME || 'CopiaProd',
        },
        salesforce: getSalesforceConfig(),
    };
}

/** Lets read-only Salesforce commands run without requiring an unused DDI API setting. */
export function getSalesforceConfig() {
    return {
            loginUrl: required('SF_LOGIN_URL'),
            username: required('SF_USERNAME'),
            password: required('SF_PASSWORD'),
            securityToken: required('SF_SECURITY_TOKEN'),
            // v1.0: every Case is assigned directly to KA (Salesforce
            // Username, not email). Faster to set up than a Queue for
            // today's sprint — swap to Setup > Queues later, it's a
            // one-line config change, not a redesign.
            defaultOwnerUsername: required('SF_DEFAULT_OWNER_USERNAME'),
    };
}

export function getReleaseConfig() {
    // Used only when a resolved Case has no Resolved_By__c value.
    const releasedBy = required('SAPPHIRE_RELEASED_BY').trim();
    if (!releasedBy || releasedBy.length > 20) {
        throw new Error(
            'SAPPHIRE_RELEASED_BY must be between 1 and 20 characters after trimming.'
        );
    }

    return {
        sapphireWriteConnectName: required('SAPPHIRE_WRITE_CONNECT_NAME'),
        releasedBy: releasedBy.toLowerCase(),
    };
}

/** Configuration needed exclusively by the Salesforce-to-Copia release command. */
export function getCopiaReleaseConfig() {
    return {
        // Intentionally has no default: this command must never silently use CopiaProd.
        copiaWriteConnectName: required('COPIA_WRITE_CONNECT_NAME'),
    };
}

/** Configuration needed exclusively by the Salesforce-to-Sapphire notes command. */
export function getNotesConfig() {
    return {
        sapphireWriteConnectName: required('SAPPHIRE_WRITE_CONNECT_NAME'),
    };
}
