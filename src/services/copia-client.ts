/** Reads Copia hold data through the DDIVbNetApis REST API. */

export interface CopiaHoldRow {
    orderedPanelKey: number;
    requisitionNumber: string;
    labPanelCode: string;
    holdName: string;
    panelKey: number;
    createdUtc: Date | null;
    isCancelled: boolean;
    cancelledUtc: Date | null;
    releasedByLastName: string | null;
    cancelReason: string | null;
    accountId: string | null;
    practiceName: string | null;
    practicePhone: string | null;
    providerFirstName: string | null;
    providerLastName: string | null;
    patientId: string | null;
    patientFirstName: string | null;
    patientLastName: string | null;
    patientPhone: string | null;
    commentText: string | null;
}

interface ApiErrorMessage {
    Description?: string;
}

interface ApiResponse {
    ErrorMessages: ApiErrorMessage[];
}

interface ApiCopiaHoldRow {
    OrderedPanelKey: number;
    RequisitionNumber: string;
    LabPanelCode: string;
    HoldName: string;
    PanelKey: number;
    CreatedUtc: string | null;
    IsCancelled: boolean;
    CancelledUtc: string | null;
    ReleasedByLastName: string | null;
    CancelReason: string | null;
    AccountId: string | null;
    PracticeName: string | null;
    PracticePhone: string | null;
    ProviderFirstName: string | null;
    ProviderLastName: string | null;
    PatientId: string | null;
    PatientFirstName: string | null;
    PatientLastName: string | null;
    PatientPhone: string | null;
    CommentText: string | null;
}

interface HoldsResponse extends ApiResponse {
    Holds: ApiCopiaHoldRow[];
}

export class CopiaHoldClient {
    constructor(
        private config: {
            baseUrl: string;
            copiaConnectName: string;
        }
    ) { }

    private async post<T extends ApiResponse>(endpoint: string, body: unknown): Promise<T> {
        const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
        const connectName = encodeURIComponent(this.config.copiaConnectName);
        const response = await fetch(
            `${baseUrl}/api/DDILibrary/${endpoint}?copiaConnectName=${connectName}`,
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

    private parseHoldRow(row: ApiCopiaHoldRow): CopiaHoldRow {
        if (row.CreatedUtc === null) {
            throw new Error(`Copia hold ${row.OrderedPanelKey} has no CreatedUtc`);
        }

        return {
            orderedPanelKey: row.OrderedPanelKey,
            requisitionNumber: row.RequisitionNumber,
            labPanelCode: row.LabPanelCode,
            holdName: row.HoldName,
            panelKey: row.PanelKey,
            createdUtc: new Date(row.CreatedUtc),
            isCancelled: row.IsCancelled,
            cancelledUtc: row.CancelledUtc ? new Date(row.CancelledUtc) : null,
            releasedByLastName: row.ReleasedByLastName,
            cancelReason: row.CancelReason,
            accountId: row.AccountId,
            practiceName: row.PracticeName,
            practicePhone: row.PracticePhone,
            providerFirstName: row.ProviderFirstName,
            providerLastName: row.ProviderLastName,
            patientId: row.PatientId,
            patientFirstName: row.PatientFirstName,
            patientLastName: row.PatientLastName,
            patientPhone: row.PatientPhone,
            commentText: row.CommentText,
        };
    }

    async fetchChangedHolds(
        sinceDate: string | null,
        openOnly: boolean
    ): Promise<CopiaHoldRow[]> {
        const response = await this.post<HoldsResponse>('Copia_GetChangedHolds', {
            sSinceDate: sinceDate,
            bOpenOnly: openOnly,
        });
        return response.Holds.map((row) => this.parseHoldRow(row));
    }
}
