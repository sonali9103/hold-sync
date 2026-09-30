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
exports.getConfig = getConfig;
const dotenv = __importStar(require("dotenv"));
dotenv.config();
function required(name) {
    const val = process.env[name];
    if (!val)
        throw new Error(`Missing required env var: ${name}`);
    return val;
}
function getConfig() {
    return {
        oracle: {
            baseUrl: required('DDI_API_BASE_URL'),
            oracleConnectName: process.env.ORACLE_CONNECT_NAME || 'Prod',
        },
        copia: {
            baseUrl: required('DDI_API_BASE_URL'),
            copiaConnectName: process.env.COPIA_CONNECT_NAME || 'CopiaProd',
        },
        salesforce: {
            loginUrl: required('SF_LOGIN_URL'),
            username: required('SF_USERNAME'),
            password: required('SF_PASSWORD'),
            securityToken: required('SF_SECURITY_TOKEN'),
            // v1.0: every Case is assigned directly to KA (Salesforce
            // Username, not email). Faster to set up than a Queue for
            // today's sprint — swap to Setup > Queues later, it's a
            // one-line config change, not a redesign.
            defaultOwnerUsername: required('SF_DEFAULT_OWNER_USERNAME'),
        },
    };
}
