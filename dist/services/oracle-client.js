"use strict";
/**
 * Reads Sapphire hold data through the DDIVbNetApis REST API.
 *
 * Sapphire runs Oracle 8i, which modern Node Oracle drivers cannot connect
 * to directly. DDIVbNetApis owns that legacy database connection; hold-sync
 * only makes HTTP requests to its supported endpoints.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OracleHoldClient = void 0;
class OracleHoldClient {
    constructor(config) {
        this.config = config;
    }
    async connect() { }
    async close() { }
    async post(endpoint, body) {
        const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
        const connectName = encodeURIComponent(this.config.oracleConnectName);
        const response = await fetch(`${baseUrl}/api/DDILibrary/${endpoint}?oracleConnectName=${connectName}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        let result;
        try {
            result = await response.json();
        }
        catch {
            if (!response.ok) {
                throw new Error(`DDIVbNetApis request failed: ${response.status} ${response.statusText}`.trim());
            }
            throw new Error('DDIVbNetApis returned an invalid JSON response.');
        }
        if (result.ErrorMessages?.length > 0) {
            throw new Error(result.ErrorMessages[0].Description ||
                `DDIVbNetApis request failed: ${response.status} ${response.statusText}`.trim());
        }
        if (!response.ok) {
            throw new Error(`DDIVbNetApis request failed: ${response.status} ${response.statusText}`.trim());
        }
        return result;
    }
    parseHoldRow(row) {
        return {
            U_DDIHOLDLISTID: row.U_DDIHOLDLISTID,
            U_SUBMISSIONID: row.U_SUBMISSIONID,
            U_HOLDCODE: row.U_HOLDCODE,
            U_HOLDCODEID: row.U_HOLDCODEID,
            NOTES: row.NOTES,
            submissionNotes: row.SubmissionNotes,
            CREATEDT: new Date(row.CREATEDT),
            CREATEBY: row.CREATEBY,
            CREATETOOL: row.CREATETOOL,
            U_OUTDATE: row.U_OUTDATE ? new Date(row.U_OUTDATE) : null,
            U_HOLDRELEASEDBY: row.U_HOLDRELEASEDBY,
            U_DOCTORID: row.U_DOCTORID,
        };
    }
    /** New and newly-resolved CS holds since the given watermark. */
    async fetchChangedHolds(sinceDate) {
        const response = await this.post('Sapphire_GetChangedHolds', {
            sSinceDate: sinceDate,
        });
        return response.Holds.map((row) => this.parseHoldRow(row));
    }
    /** No DDIVbNetApis endpoint currently supports lookup by U_DDIHOLDLISTID. */
    async fetchHoldById(_holdId) {
        throw new Error('OracleHoldClient.fetchHoldById is not yet migrated to the ' +
            'DDIVbNetApis REST API (no matching endpoint exists yet). See ' +
            "oracle-client.ts's fetchChangedHolds for the pattern to follow " +
            'once one does.');
    }
    /** Every in-scope CS hold on one submission, for focused testing. */
    async fetchHoldsBySubmissionId(submissionId) {
        const response = await this.post('Sapphire_GetSubmissionHolds', {
            sSubmissionId: submissionId,
        });
        return response.Holds.map((row) => this.parseHoldRow(row));
    }
    /** Contact join key -- SUBMISSION.U_SUBACCOUNTID per submission. */
    async fetchSubmissionSubAccountIds(submissionIds) {
        const map = new Map();
        if (submissionIds.length === 0)
            return map;
        const response = await this.post('Sapphire_GetSubmissionSubAccountIds', { SubmissionIds: submissionIds });
        for (const row of response.SubAccountIds) {
            map.set(row.SUBMISSIONID, row.U_SUBACCOUNTID);
        }
        return map;
    }
    /** Doctor/patient Case fields, joined once for a batch of submissions. */
    async fetchSubmissionContactInfo(submissionIds) {
        const map = new Map();
        if (submissionIds.length === 0)
            return map;
        const response = await this.post('Sapphire_GetSubmissionContactInfo', { SubmissionIds: submissionIds });
        for (const row of response.ContactInfo) {
            map.set(row.SUBMISSIONID, {
                doctorName: row.DoctorName,
                doctorPhone: row.DoctorPhone,
                patientName: row.PatientName,
                patientPhone: row.PatientPhone,
                patientId: row.PatientId,
            });
        }
        return map;
    }
}
exports.OracleHoldClient = OracleHoldClient;
