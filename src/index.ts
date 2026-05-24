import { createServer } from './server.js';

const PORT = Number(process.env.PORT ?? 3004);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main(): Promise<void> {
  const { app, driftScheduler } = await createServer();
  try {
    await app.listen({ port: PORT, host: HOST });
    driftScheduler.start();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
