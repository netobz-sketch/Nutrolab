import { buildApp } from './app.js';
import { aiEnabled, AI_MODEL } from './ai.js';
import { DB_PATH } from './db.js';

const PORT = Number(process.env.PORT ?? 8090);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = await buildApp();
await app.listen({ port: PORT, host: HOST });
app.log.info({ db: DB_PATH, ai: aiEnabled() ? AI_MODEL : 'desligada' }, 'NutroLab no ar');

// docker stop envia SIGTERM: termina as requisições e as consultas em fila e fecha a conexão com o banco.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'encerrando');
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, 'falha ao encerrar');
        process.exit(1);
      },
    );
  });
}
