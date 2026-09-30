"use strict";
/** Reads Copia hold data through the DDIVbNetApis REST API. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CopiaHoldClient = void 0;
class CopiaHoldClient {
    constructor(config) {
        this.config = config;
    }
    async post(endpoint, body) {
        const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
        const connectName = encodeURIComponent(this.config.copiaConnectName);
        const response = await fetch(`${baseUrl}/api/DDILibrary/${endpoint}?copiaConnectName=${connectName}`, {
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
    async fetchChangedHolds(sinceDate, openOnly) {
        const response = await this.post('Copia_GetChangedHolds', {
            sSinceDate: sinceDate,
            bOpenOnly: openOnly,
        });
        return response.Holds.map((row) => this.parseHoldRow(row));
    }
}
exports.CopiaHoldClient = CopiaHoldClient;
