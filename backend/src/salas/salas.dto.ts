import { IsIn, IsString, Length } from 'class-validator';

// Sección 9 del enunciado: únicos temas permitidos
export const TEMAS_VALIDOS: string[] = [
  'Angular', 'TypeScript', 'JavaScript', 'Python', 'Java', 'C#', 'Go',
  'Node.js', 'NestJS', 'React', 'Vue', 'HTML', 'CSS', 'SQL', 'PostgreSQL',
  'MongoDB', 'Docker', 'Git', 'GitHub', 'AWS', 'Azure', 'APIs REST',
  'WebSockets', 'Ciberseguridad', 'Algoritmos', 'Estructuras de datos',
  'Bases de datos', 'Arquitectura de software',
];

export class CrearSalaDto {
  @IsString()
  @Length(2, 16)
  nickname: string;

  @IsIn(TEMAS_VALIDOS)
  tema: string;
}

export class UnirseSalaDto {
  @IsString()
  @Length(2, 16)
  nickname: string;
}