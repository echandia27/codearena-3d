import 'dotenv/config'; // debe ir primero: carga el .env antes que todo
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Permite que Angular (localhost:4200) llame a esta API (CORS)
  app.enableCors();

  // Valida los DTO en TODOS los endpoints automáticamente
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`🚀 API lista en http://localhost:${port}`);
}
bootstrap();