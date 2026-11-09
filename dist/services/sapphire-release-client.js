"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SapphireReleaseClient = exports.RELEASE_CHUNK_SIZE = exports.RELEASE_REQUEST_TIMEOUT_MS = void 0;
exports.chunkReleases = chunkReleases;
exports.RELEASE_REQUEST_TIMEOUT_MS = 60000;
// Must be <= the per-request cap in the Sapphire_ReleaseHolds service; confirm before --apply.
exports.RELEASE_CHUNK_SIZE = 25;
function chunkReleases(releases) {
    const chunks = [];
    for (let index = 0; index < releases.length; index += exports.RELEASE_CHUNK_SIZE) {
        chunks.push(releases.slice(index, index + exports.RELEASE_CHUNK_SIZE));
    }
    return chunks;
}
class SapphireReleaseClient {
    constructor(config) {
        this.config = config;
    }
    async releaseChunk(releases, dryRun) {
        const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
        const connectName = encodeURIComponent(this.config.oracleConnectName);
        let response;
        try {
            response = await fetch(`${baseUrl}/api/DDILibrary/Sapphire_ReleaseHolds?oracleConnectName=${connectName}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ Releases: releases, bDryRun: dryRun }),
                signal: AbortSignal.timeout(exports.RELEASE_REQUEST_TIMEOUT_MS),
            });
        }
        catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(`Sapphire release request failed: ${detail}; the outcome of this batch is unknown; ` +
                'rerunning is safe because already-released holds report AlreadyReleased');
        }
        let result;
        try {
            result = await response.json();
        }
        catch {
            throw new Error(`Sapphire release request failed: ${response.status} ${response.statusText}; ` +
                'response was not valid JSON');
        }
        if (result.ErrorMessages?.length > 0) {
            const descriptions = result.ErrorMessages
                .map((message) => message.Description || '(no description)')
                .join('; ');
            throw new Error(`Sapphire release request failed: ${response.status} ${response.statusText}: ` +
                descriptions);
        }
        if (!response.ok) {
            throw new Error(`Sapphire release request failed: ${response.status} ${response.statusText}`.trim());
        }
        if (!Array.isArray(result.Results)) {
            throw new Error(`Sapphire release request failed: ${response.status} ${response.statusText}: ` +
                'response Results was not an array');
        }
        return result;
    }
}
exports.SapphireReleaseClient = SapphireReleaseClient;
