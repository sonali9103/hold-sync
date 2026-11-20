export const NOTES_REQUEST_TIMEOUT_MS = 60000;
export const NOTES_CHUNK_SIZE = 25;

export type SapphireNotesOutcome =
    | 'Updated'
    | 'WouldUpdate'
    | 'Changed'
    | 'Locked'
    | 'TooLong'
    | 'NotFound'
    | 'Rejected'
    | 'Error';

export interface SapphireNotesUpdate {
    SubmissionId: string;
    ExpectedNotes: string | null;
    AppendText: string;
}

export interface SapphireNotesResult {
    SubmissionId: string;
    Outcome: SapphireNotesOutcome;
    Message: string | null;
}

interface ApiErrorMessage {
    Description?: string;
}

export interface SapphireNotesResponse {
    DryRun: boolean;
    Results: SapphireNotesResult[];
    ErrorMessages: ApiErrorMessage[];
}

/** The injectable Sapphire write boundary used by notes-sync and its tests. */
export interface SapphireNotesClient {
    appendNotesChunk(
        updates: SapphireNotesUpdate[],
        dryRun: boolean
    ): Promise<SapphireNotesResponse>;
}

export function chunkNotesUpdates(updates: SapphireNotesUpdate[]): SapphireNotesUpdate[][] {
    const chunks: SapphireNotesUpdate[][] = [];
    for (let index = 0; index < updates.length; index += NOTES_CHUNK_SIZE) {
        chunks.push(updates.slice(index, index + NOTES_CHUNK_SIZE));
    }
    return chunks;
}

export class SapphireNotesApiClient implements SapphireNotesClient {
    constructor(
        private config: {
            baseUrl: string;
            oracleConnectName: string;
        }
    ) { }

    async appendNotesChunk(
        updates: SapphireNotesUpdate[],
        dryRun: boolean
    ): Promise<SapphireNotesResponse> {
        const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
        const connectName = encodeURIComponent(this.config.oracleConnectName);

        let response: Response;
        try {
            response = await fetch(
                `${baseUrl}/api/DDILibrary/Sapphire_AppendNotes?oracleConnectName=${connectName}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        Updates: updates,
                        bDryRun: dryRun,
                        ModifiedBy: 'sfsync',
                    }),
                    signal: AbortSignal.timeout(NOTES_REQUEST_TIMEOUT_MS),
                }
            );
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(
                `Sapphire notes request failed: ${detail}; the outcome of this batch is unknown.`
            );
        }

        let result: SapphireNotesResponse;
        try {
            result = await response.json() as SapphireNotesResponse;
        } catch {
            throw new Error(
                `Sapphire notes request failed: ${response.status} ${response.statusText}; ` +
                'response was not valid JSON'
            );
        }

        // Sapphire can return a per-submission outcome payload with HTTP 500. Those
        // outcomes are actionable, so they must not be turned into a request-level failure.
        if (Array.isArray(result.Results)) return result;

        if (result.ErrorMessages?.length > 0) {
            const descriptions = result.ErrorMessages
                .map((message) => message.Description || '(no description)')
                .join('; ');
            throw new Error(
                `Sapphire notes request failed: ${response.status} ${response.statusText}: ` +
                descriptions
            );
        }
        if (!response.ok) {
            throw new Error(
                `Sapphire notes request failed: ${response.status} ${response.statusText}`.trim()
            );
        }
        throw new Error(
            `Sapphire notes request failed: ${response.status} ${response.statusText}: ` +
            'response Results was not an array'
        );
    }
}
