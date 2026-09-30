/**
 * Reads Sapphire hold data through the DDIVbNetApis REST API.
 *
 * Sapphire runs Oracle 8i, which modern Node Oracle drivers cannot connect
 * to directly. DDIVbNetApis owns that legacy database connection; hold-sync
 * only makes HTTP requests to its supported endpoints.
 */

export interface HoldRow {
    U_DDIHOLDLISTID: string;
    U_SUBMISSIONID: string;
    U_HOLDCODE: string;
    U_HOLDCODEID: number;
    NOTES: string | null;
    CREATEDT: Date;
    CREATEBY: string;
    CREATETOOL: string;
    U_OUTDATE: Date | null;
    U_HOLDRELEASEDBY: string | null;
    U_DOCTORID: string | null;
}

export interface SubmissionRow {
    SUBMISSIONID: string;
    U_DOCTORID: string | null;
    U_SUBACCOUNTID: string | null;
}

export interface SubmissionContactInfo {
    doctorName: string | null;
    doctorPhone: string | null;
    patientName: string | null;
    patientPhone: string | null;
    patientId: string | null;
}

interface ApiErrorMessage {
    Description?: string;
}

interface ApiResponse {
    ErrorMessages: ApiErrorMessage[];
}

interface ApiHoldRow {
    U_DDIHOLDLISTID: string;
    U_SUBMISSIONID: string;
    U_HOLDCODE: string;
    U_HOLDCODEID: number;
    NOTES: string | null;
    CREATEDT: string | null;
    CREATEBY: string | null;
    CREATETOOL: string | null;
    U_OUTDATE: string | null;
    U_HOLDRELEASEDBY: string | null;
    U_DOCTORID: string | null;
}

interface HoldsResponse extends ApiResponse {
    Holds: ApiHoldRow[];
}

interface SubAccountIdsResponse extends ApiResponse {
    SubAccountIds: Array<{
        SUBMISSIONID: string;
        U_SUBACCOUNTID: string | null;
    }>;
}

interface ContactInfoResponse extends ApiResponse {
    ContactInfo: Array<{
        SUBMISSIONID: string;
        DoctorName: string | null;
        DoctorPhone: string | null;
        PatientName: string | null;
        PatientPhone: string | null;
        PatientId: string | null;
    }>;
}

export class OracleHoldClient {
    constructor(
        private config: {
            baseUrl: string;
            oracleConnectName: string;
        }
    ) { }

    async connect(): Promise<void> { }

    async close(): Promise<void> { }

    private async post<T extends ApiResponse>(endpoint: string, body: unknown): Promise<T> {
        const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
        const connectName = encodeURIComponent(this.config.oracleConnectName);
        const response = await fetch(
            `${baseUrl}/api/DDILibrary/${endpoint}?oracleConnectName=${connectName}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }
        );

        let result: T;
        try {
            result = await response.json() as T;
        } catch {
            if (!response.ok) {
                throw new Error(
                    `DDIVbNetApis request failed: ${response.status} ${response.statusText}`.trim()
                );
            }
            throw new Error('DDIVbNetApis returned an invalid JSON response.');
        }

        if (result.ErrorMessages?.length > 0) {
            throw new Error(
                result.ErrorMessages[0].Description ||
                `DDIVbNetApis request failed: ${response.status} ${response.statusText}`.trim()
            );
        }
        if (!response.ok) {
            throw new Error(
                `DDIVbNetApis request failed: ${response.status} ${response.statusText}`.trim()
            );
        }

        return result;
    }

    private parseHoldRow(row: ApiHoldRow): HoldRow {
        return {
            U_DDIHOLDLISTID: row.U_DDIHOLDLISTID,
            U_SUBMISSIONID: row.U_SUBMISSIONID,
            U_HOLDCODE: row.U_HOLDCODE,
            U_HOLDCODEID: row.U_HOLDCODEID,
            NOTES: row.NOTES,
            CREATEDT: new Date(row.CREATEDT as string),
            CREATEBY: row.CREATEBY as string,
            CREATETOOL: row.CREATETOOL as string,
            U_OUTDATE: row.U_OUTDATE ? new Date(row.U_OUTDATE) : null,
            U_HOLDRELEASEDBY: row.U_HOLDRELEASEDBY,
            U_DOCTORID: row.U_DOCTORID,
        };
    }

    /** New and newly-resolved CS holds since the given watermark. */
    async fetchChangedHolds(sinceDate: string): Promise<HoldRow[]> {
        const response = await this.post<HoldsResponse>('Sapphire_GetChangedHolds', {
            sSinceDate: sinceDate,
        });
        return response.Holds.map((row) => this.parseHoldRow(row));
    }

    /** No DDIVbNetApis endpoint currently supports lookup by U_DDIHOLDLISTID. */
    async fetchHoldById(_holdId: string): Promise<HoldRow | null> {
        throw new Error(
            'OracleHoldClient.fetchHoldById is not yet migrated to the ' +
            'DDIVbNetApis REST API (no matching endpoint exists yet). See ' +
            "oracle-client.ts's fetchChangedHolds for the pattern to follow " +
            'once one does.'
        );
    }

    /** Every in-scope CS hold on one submission, for focused testing. */
    async fetchHoldsBySubmissionId(submissionId: string): Promise<HoldRow[]> {
        const response = await this.post<HoldsResponse>('Sapphire_GetSubmissionHolds', {
            sSubmissionId: submissionId,
        });
        return response.Holds.map((row) => this.parseHoldRow(row));
    }

    /** Contact join key -- SUBMISSION.U_SUBACCOUNTID per submission. */
    async fetchSubmissionSubAccountIds(
        submissionIds: string[]
    ): Promise<Map<string, string | null>> {
        const map = new Map<string, string | null>();
        if (submissionIds.length === 0) return map;

        const response = await this.post<SubAccountIdsResponse>(
            'Sapphire_GetSubmissionSubAccountIds',
            { SubmissionIds: submissionIds }
        );
        for (const row of response.SubAccountIds) {
            map.set(row.SUBMISSIONID, row.U_SUBACCOUNTID);
        }
        return map;
    }

    /** Doctor/patient Case fields, joined once for a batch of submissions. */
    async fetchSubmissionContactInfo(
        submissionIds: string[]
    ): Promise<Map<string, SubmissionContactInfo>> {
        const map = new Map<string, SubmissionContactInfo>();
        if (submissionIds.length === 0) return map;

        const response = await this.post<ContactInfoResponse>(
            'Sapphire_GetSubmissionContactInfo',
            { SubmissionIds: submissionIds }
        );
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
