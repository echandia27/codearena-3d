import { BadRequestException, Body, Controller, Get, HttpCode, HttpException, Post, Query } from '@nestjs/common';
import { IsIn } from 'class-validator';
import { TEMAS_VALIDOS } from '../salas/salas.dto';
import { IaError, Pregunta, TipoFalloIa } from './gemini.service';
import { PreguntasService } from './preguntas.service';

const FALLOS_SIMULABLES: TipoFalloIa[] = ['no_responde', 'formato', 'limite'];

class PrecalentarDto {
  @IsIn(TEMAS_VALIDOS)
  tema: string;
}

@Controller('ia')
export class IaController {
  constructor(private readonly preguntas: PreguntasService) {}

  /**
   * Herramienta de desarrollo/demo: el JUEGO no la usa (pedirá preguntas
   * por WebSocket en la 4B). Permite verificar la generación y, con
   * ?forzarError=, demostrar los respaldos de R5 de forma reproducible.
   */
  @Get('pregunta')
  async pregunta(
    @Query('tema') tema: string,
    @Query('forzarError') forzarError?: string,
  ): Promise<Pregunta> {
    if (!TEMAS_VALIDOS.includes(tema)) {
      throw new BadRequestException(
        `Tema no válido. Usa uno de: ${TEMAS_VALIDOS.join(', ')}`,
      );
    }
    let simulacion: TipoFalloIa | undefined;
    if (forzarError) {
      if (!FALLOS_SIMULABLES.includes(forzarError as TipoFalloIa)) {
        throw new BadRequestException(
          `forzarError debe ser uno de: ${FALLOS_SIMULABLES.join(', ')}`,
        );
      }
      simulacion = forzarError as TipoFalloIa;
    }

    try {
      return await this.preguntas.obtenerPregunta(tema, simulacion);
    } catch (error) {
      if (error instanceof IaError) {
        // R5: el fallo se expresa como mensaje entendible y tipado
        throw new HttpException(
          { error: error.tipo, mensaje: error.message },
          503,
        );
      }
      throw error;
    }
  }

  /** Llena el pool de respaldo de un tema (en el juego lo hará el countdown). */
  @Post('precalentar')
  @HttpCode(200)
  async precalentar(@Body() dto: PrecalentarDto) {
    const guardadas = await this.preguntas.precalentar(dto.tema);
    return { tema: dto.tema, guardadas };
  }
}