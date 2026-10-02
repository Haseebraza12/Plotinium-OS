import { defineConfig } from 'vite';
const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' };
export default defineConfig({ server: { headers }, preview: { headers }, worker: { format: 'es' } });
