import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { SalasService } from './salas.service';
import { CrearSalaDto, UnirseSalaDto } from './salas.dto';

@Controller('salas')
export class SalasController {
  constructor(private readonly salasService: SalasService) {}

  @Post()
  crear(@Body() dto: CrearSalaDto) {
    return this.salasService.crear(dto);
  }

  @Post(':codigo/jugadores')
  unirse(@Param('codigo') codigo: string, @Body() dto: UnirseSalaDto) {
    return this.salasService.unirse(codigo, dto.nickname);
  }

  @Get(':codigo')
  obtener(@Param('codigo') codigo: string) {
    return this.salasService.obtenerPorCodigo(codigo);
  }
}