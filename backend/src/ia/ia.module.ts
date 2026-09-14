import { Module } from '@nestjs/common';
import { IaController } from './ia.controller';
import { GeminiService } from './gemini.service';
import { PreguntasService } from './preguntas.service';

@Module({
  controllers: [IaController],
  providers: [GeminiService, PreguntasService],
  exports: [PreguntasService], // el gateway lo usará en la 4B
})
export class IaModule {}