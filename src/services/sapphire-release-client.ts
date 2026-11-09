export const RELEASE_REQUEST_TIMEOUT_MS = 60000;

// Must be <= the per-request cap in the Sapphire_ReleaseHolds service; confirm before --apply.
export const RELEASE_CHUNK_SIZE = 25;

export type ReleaseOutcome =
    | 'Released'
    | 'WouldRelease'
    | 'AlreadyReleased'
    | 'NotFound'
    | 'Rejected'
    | 'Error';

export interface SapphireRelease {
    HoldId: string;
    ReleasedBy: string;
    CaseNumber: string;
}

export interface SapphireReleaseResult {
    HoldId: string;
    CaseNumber: string;
    Outcome: ReleaseOutcome;
    Message: string | null;
}

interface ApiErrorMessage {
    Description?: string;
}

export interface SapphireReleaseResponse {
    DryRun: boolean;
    Results: SapphireReleaseResult[];
    ErrorMessages: ApiErrorMessage[];
}

export function chunkReleases(releases: SapphireRelease[]): SapphireRelease[][] {
    const chunks: SapphireRelease[][] = [];
    for (let index = 0; index < releases.length; index += RELEASE_CHUNK_SIZE) {
        chunks.push(releases.slice(index, index + RELEASE_CHUNK_SIZE));
    }
    return chunks;
}

export class SapphireReleaseClient {
    constructor(
        private config: {
            baseUrl: string;
            oracleConnectName: string;
        }
    ) { }

    async releaseChunk(
        releases: SapphireRelease[],
        dryRun: boolean
    ): Promise<SapphireReleaseResponse> {
        const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
        const connectName = encodeURIComponent(this.config.oracleConnectName);

        let response: Response;
        try {
            response = await fetch(
                `${baseUrl}/api/DDILibrary/Sapphire_ReleaseHolds?oracleConnectName=${connectName}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ Releases: releases, bDryRun: dryRun }),
                    signal: AbortSignal.timeout(RELEASE_REQUEST_TIMEOUT_MS),
                }
            );
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(
                `Sapphire release request failed: ${detail}; the outcome of this batch is unknown; ` +
                'rerunning is safe because already-released holds report AlreadyReleased'
            );
        }

        let result: SapphireReleaseResponse;
        try {
            result = await response.json() as SapphireReleaseResponse;
        } catch {
            throw new Error(
                `Sapphire release request failed: ${response.status} ${response.statusText}; ` +
                'response was not valid JSON'
            );
        }

        if (result.ErrorMessages?.length > 0) {
            const descriptions = result.ErrorMessages
                .map((message) => message.Description || '(no description)')
                .join('; ');
            throw new Error(
                `Sapphire release request failed: ${response.status} ${response.statusText}: ` +
                descriptions
            );
        }
        if (!response.ok) {
            throw new Error(
                `Sapphire release request failed: ${response.status} ${response.statusText}`.trim()
            );
        }
        if (!Array.isArray(result.Results)) {
            throw new Error(
                `Sapphire release request failed: ${response.status} ${response.statusText}: ` +
                'response Results was not an array'
            );
        }

        return result;
    }
}
