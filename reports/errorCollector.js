// reports/errorCollector.js
import { reportError, reportSystem } from './reportManager.js';

let installed = false;

export function installGlobalErrorHandlers() {
    if (installed) return;
    installed = true;

    process.on('uncaughtException', async (err) => {
        console.error('[FATAL] Uncaught Exception:', err);
        await reportError({
            type: 'uncaughtException',
            message: err.message,
            stack: err.stack,
            timestamp: new Date().toISOString()
        });
        if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
            process.exit(1);
        }
    });

    process.on('unhandledRejection', async (reason) => {
        console.error('[UNHANDLED REJECTION]', reason);
        await reportError({
            type: 'unhandledRejection',
            message: reason?.message || String(reason),
            stack: reason?.stack || '',
            timestamp: new Date().toISOString()
        });
    });

    process.on('warning', async (warning) => {
        if (warning.name === 'DeprecationWarning' && warning.message.includes('Baileys')) {
            await reportError({
                type: 'warning',
                message: warning.message,
                stack: warning.stack,
                timestamp: new Date().toISOString()
            });
        }
    });

    process.on('multipleResolves', async (type, promise, reason) => {
        await reportError({
            type: 'multipleResolves',
            message: `Type: ${type}, Reason: ${reason}`,
            stack: '',
            timestamp: new Date().toISOString()
        });
    });

    process.on('exit', async (code) => {
        await reportSystem('exit', `Bot exit with code ${code}`);
    });

    console.log('[ErrorCollector] ✅ Global error handlers terpasang.');
}