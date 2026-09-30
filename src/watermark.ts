import * as fs from 'fs';
import * as path from 'path';

const WATERMARK_FILE = path.join(__dirname, '..', '.hold-sync-watermark.json');
const COPIA_WATERMARK_FILE = path.join(__dirname, '..', '.hold-sync-watermark.copia.json');
const MONTHS = [
    'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
    'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];

export function isValidWatermarkDate(value: unknown): value is string {
    if (typeof value !== 'string') return false;

    const match = /^(\d{2})-([A-Z]{3})-(\d{4})$/.exec(value);
    if (!match) return false;

    const day = Number(match[1]);
    const month = MONTHS.indexOf(match[2]);
    const year = Number(match[3]);
    if (month === -1) return false;

    const date = new Date(year, month, day);
    return date.getFullYear() === year
        && date.getMonth() === month
        && date.getDate() === day;
}

export function formatWatermarkDate(date: Date): string {
    const day = String(date.getDate()).padStart(2, '0');
    return `${day}-${MONTHS[date.getMonth()]}-${date.getFullYear()}`;
}

export function formatUtcWatermarkDate(date: Date): string {
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${day}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

function watermarkFile(source: 'sapphire' | 'copia'): string {
    return source === 'copia' ? COPIA_WATERMARK_FILE : WATERMARK_FILE;
}

export function readWatermark(source: 'sapphire' | 'copia' = 'sapphire'): string | null {
    const file = watermarkFile(source);
    const logPrefix = source === 'copia' ? '[copia] ' : '';
    try {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (isValidWatermarkDate(state.sinceDate)) return state.sinceDate;

        console.warn(`${logPrefix}Watermark file is invalid; using configured default.`);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn(`${logPrefix}Unable to read watermark file; using configured default.`);
        }
    }
    return null;
}

export function writeWatermark(
    sinceDate: string,
    source: 'sapphire' | 'copia' = 'sapphire'
): void {
    const file = watermarkFile(source);
    const tempFile = `${file}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tempFile, `${JSON.stringify({ sinceDate }, null, 2)}\n`);
        fs.renameSync(tempFile, file);
    } finally {
        try {
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        } catch { }
    }
}
