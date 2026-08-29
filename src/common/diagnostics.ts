import { appendFileSync } from 'fs';

const DIAGNOSTICS_PATH = '/tmp/whale-tracker-diagnostics.ndjson';

export function writeDiagnostic(component: string, event: string, data: unknown): void {
    try {
        appendFileSync(
            DIAGNOSTICS_PATH,
            `${JSON.stringify({ timestamp: new Date().toISOString(), component, event, data })}\n`
        );
    } catch {}
}
