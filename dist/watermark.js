"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidWatermarkDate = isValidWatermarkDate;
exports.formatWatermarkDate = formatWatermarkDate;
exports.formatUtcWatermarkDate = formatUtcWatermarkDate;
exports.readWatermark = readWatermark;
exports.writeWatermark = writeWatermark;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const WATERMARK_FILE = path.join(__dirname, '..', '.hold-sync-watermark.json');
const COPIA_WATERMARK_FILE = path.join(__dirname, '..', '.hold-sync-watermark.copia.json');
const MONTHS = [
    'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
    'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];
function isValidWatermarkDate(value) {
    if (typeof value !== 'string')
        return false;
    const match = /^(\d{2})-([A-Z]{3})-(\d{4})$/.exec(value);
    if (!match)
        return false;
    const day = Number(match[1]);
    const month = MONTHS.indexOf(match[2]);
    const year = Number(match[3]);
    if (month === -1)
        return false;
    const date = new Date(year, month, day);
    return date.getFullYear() === year
        && date.getMonth() === month
        && date.getDate() === day;
}
function formatWatermarkDate(date) {
    const day = String(date.getDate()).padStart(2, '0');
    return `${day}-${MONTHS[date.getMonth()]}-${date.getFullYear()}`;
}
function formatUtcWatermarkDate(date) {
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${day}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}
function watermarkFile(source) {
    return source === 'copia' ? COPIA_WATERMARK_FILE : WATERMARK_FILE;
}
function readWatermark(source = 'sapphire') {
    const file = watermarkFile(source);
    const logPrefix = source === 'copia' ? '[copia] ' : '';
    try {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (isValidWatermarkDate(state.sinceDate))
            return state.sinceDate;
        console.warn(`${logPrefix}Watermark file is invalid; using configured default.`);
    }
    catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn(`${logPrefix}Unable to read watermark file; using configured default.`);
        }
    }
    return null;
}
function writeWatermark(sinceDate, source = 'sapphire') {
    const file = watermarkFile(source);
    const tempFile = `${file}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tempFile, `${JSON.stringify({ sinceDate }, null, 2)}\n`);
        fs.renameSync(tempFile, file);
    }
    finally {
        try {
            if (fs.existsSync(tempFile))
                fs.unlinkSync(tempFile);
        }
        catch { }
    }
}
