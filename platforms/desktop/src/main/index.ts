/**
 * The desktop's entry: the app, or the CLIP worker (ai/embedWorker.ts, docs/plan-discover-scan.md),
 * the same executable started apart with its own GPU options (WebGPU on Vulkan, which the app's
 * own rendering keeps off). Awaited: Electron starts once the chosen part has set itself up.
 */
if (process.argv.includes('--hub-ai-embed-worker')) await import('./ai/embedWorker')
else await import('./app')

export {}
