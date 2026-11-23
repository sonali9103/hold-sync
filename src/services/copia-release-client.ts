export const COPIA_RELEASE_REQUEST_TIMEOUT_MS = 60000;

// Must remain at or below Copia_ReleaseHold.MaxItemsPerRequest.
export const COPIA_RELEASE_CHUNK_SIZE = 25;

export type CopiaReleaseOutcome =
    | 'Updated'
    | 'WouldUpdate'
    | 'AlreadyReleased'
    | 'Changed'
    | 'NotFound'
    | 'Rejected'
    | 'Error';

export interface CopiaRelease {
    OrderedPanelKey: number;
    ResolvedBy: string;
    Reason: string;
}

export interface CopiaReleaseResult {
    OrderedPanelKey: number;
    Outcome: CopiaReleaseOutcome;
    Message: string | null;
}

interface ApiErrorMessage {
    Description?: string;
}

export interface CopiaReleaseResponse {
    DryRun: boolean;
    Results: CopiaReleaseResult[];
    ErrorMessages: ApiErrorMessage[];
}

export function chunkCopiaReleases(releases: CopiaRelease[]): CopiaRelease[][] {
    const chunks: CopiaRelease[][] = [];
    for (let index = 0; index < releases.length; index += COPIA_RELEASE_CHUNK_SIZE) {
        chunks.push(releases.slice(index, index + COPIA_RELEASE_CHUNK_SIZE));
    }
    return chunks;
}

export interface CopiaDryRunDetails {
    staffKey: number;
    changeLogMessage: string;
}

/** Parses the documented WouldUpdate Message emitted by the guarded Dev endpoint. */
export function parseCopiaDryRunDetails(message: string | null): CopiaDryRunDetails | null {
    if (!message) return null;
    const prefix = 'StaffKey=';
    const delimiter = '; ChangeLogMessage=';
    if (!message.startsWith(prefix)) return null;
    const delimiterIndex = message.indexOf(delimiter);
    if (delimiterIndex === -1) return null;

    const staffKeyText = message.slice(prefix.length, delimiterIndex);
    if (!/^-?\d+$/.test(staffKeyText)) return null;
    return {
        staffKey: Number(staffKeyText),
        changeLogMessage: message.slice(delimiterIndex + delimiter.length),
    };
}

export class CopiaReleaseClient {
    constructor(
        private config: {
            baseUrl: string;
            copiaConnectName: string;
        }
    ) { }

    async releaseChunk(
        releases: CopiaRelease[],
        apply: boolean
    ): Promise<CopiaReleaseResponse> {
        const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
        const connectName = encodeURIComponent(this.config.copiaConnectName);

        let response: Response;
        try {
            response = await fetch(
                `${baseUrl}/api/DDILibrary/Copia_ReleaseHold?copiaConnectName=${connectName}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ Apply: apply, Items: releases }),
                    signal: AbortSignal.timeout(COPIA_RELEASE_REQUEST_TIMEOUT_MS),
                }
            );
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(
                `Copia release request failed: ${detail}; the outcome of this batch is unknown; ` +
                'rerunning is safe because already-released holds report AlreadyReleased'
            );
        }

        let result: CopiaReleaseResponse;
        try {
            result = await response.json() as CopiaReleaseResponse;
        } catch {
            throw new Error(
                `Copia release request failed: ${response.status} ${response.statusText}; ` +
                'response was not valid JSON'
            );
        }

        if (result.ErrorMessages?.length > 0) {
            const descriptions = result.ErrorMessages
                .map((message) => message.Description || '(no description)')
                .join('; ');
            throw new Error(
                `Copia release request failed: ${response.status} ${response.statusText}: ${descriptions}`
            );
        }
        if (!response.ok) {
            throw new Error(
                `Copia release request failed: ${response.status} ${response.statusText}`.trim()
            );
        }
        if (!Array.isArray(result.Results)) {
            throw new Error(
                `Copia release request failed: ${response.status} ${response.statusText}: ` +
                'response Results was not an array'
            );
        }

        return result;
    }
}
