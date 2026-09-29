import { createApp } from './app.mjs';
import { resolve } from 'node:path';
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '127.0.0.1';
const instance = createApp({ dataDir: resolve(process.env.DATA_DIR || './data') });
const server = instance.app.listen(port, host, () => {
  console.log(`APIRouter listening on http://${host}:${port}`);
  if (instance.setupToken) console.log(`首次管理员设置码（仅本次启动有效）：${instance.setupToken}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { instance.abortAll(); server.close(() => { instance.close(); process.exit(0); }); });
