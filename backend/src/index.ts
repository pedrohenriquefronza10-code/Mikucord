import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { pool } from './db.js';
import { redis } from './redis.js';
import { s3 } from './media.js';
await migrate();
const app = await buildApp();
await app.listen({ host: '0.0.0.0', port: config.PORT });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void app
      .close()
      .then(() => Promise.all([pool.end(), redis.quit()]))
      .then(() => {
        s3.destroy();
        process.exit(0);
      });
  });
