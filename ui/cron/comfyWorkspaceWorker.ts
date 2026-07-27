import prisma from './prisma';
import { reconcileComfyWorkspaces } from './comfy/orchestrator';

const intervalMs = 3_000;
let running = false;

const run = async () => {
  if (running) return;
  running = true;
  try {
    await reconcileComfyWorkspaces();
  } catch (error) {
    console.error('Comfy workspace worker failed:', error);
  } finally {
    running = false;
  }
};

const timer = setInterval(() => void run(), intervalMs);
void run();
console.log(`Comfy workspace worker started with interval ${intervalMs} ms.`);

const shutdown = async () => {
  clearInterval(timer);
  await prisma.$disconnect();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
