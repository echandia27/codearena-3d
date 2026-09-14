import 'dotenv/config'; // debe ir primero: carga el .env antes que todo
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DatabaseService } from './database/database.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Permite que Angular (localhost:4200) llame a esta API (CORS)
  app.enableCors();

  // Valida los DTO en TODOS los endpoints automáticamente
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // ---------------------------------------------------------------
  // Limpieza de arranque: las partidas viven en la memoria del
  // proceso, así que toda sala que quedó en PLAYING de una ejecución
  // anterior es huérfana (su partida murió con el proceso). Se marca
  // FINISHED para que no quede en estado inconsistente (sección 5 del
  // enunciado: no se puede volver atrás, y PLAYING sin partida lo es).
  // ---------------------------------------------------------------
  const db = app.get(DatabaseService);
  const limpiadas = await db.pool.query(
    `UPDATE salas SET estado = 'FINISHED' WHERE estado = 'PLAYING'`,
  );
  if (limpiadas.rowCount && limpiadas.rowCount > 0) {
    console.log(`🧹 ${limpiadas.rowCount} sala(s) huérfana(s) marcadas FINISHED`);
  }

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`🚀 API lista en http://localhost:${port}`);
}
bootstrap();