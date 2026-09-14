-- ============================================================
-- CodeArena 3D — Esquema de base de datos (Sesión 3B)
-- Ejecutar en Supabase > SQL Editor para recrear la BD completa.
--
-- Notas de arquitectura:
-- - RLS habilitado sin políticas: la API pública de Supabase
--   queda bloqueada. Solo el backend NestJS accede, vía cadena
--   de conexión Postgres (rol administrador, no afectado por RLS).
-- - UNIQUE(sala_id, slot): regla R3 — la base de datos misma
--   impide físicamente un 5° jugador por sala.
-- - columna 'listo': marca de preparación para iniciar partida.
-- ============================================================

DROP TABLE IF EXISTS jugadores;
DROP TABLE IF EXISTS salas;

CREATE TABLE salas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo VARCHAR(4) NOT NULL UNIQUE,  -- R1: código único e irrepetible
  tema VARCHAR(50) NOT NULL,
  estado VARCHAR(10) NOT NULL DEFAULT 'WAITING'
    CHECK (estado IN ('WAITING', 'PLAYING', 'FINISHED')),
  capacidad_maxima INT NOT NULL DEFAULT 4
    CHECK (capacidad_maxima BETWEEN 1 AND 4),
  creada_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE jugadores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sala_id UUID NOT NULL REFERENCES salas(id) ON DELETE CASCADE,
  nickname VARCHAR(16) NOT NULL,
  conectado BOOLEAN NOT NULL DEFAULT true,
  listo BOOLEAN NOT NULL DEFAULT false,
  puntaje INT NOT NULL DEFAULT 0,
  slot INT NOT NULL,
  -- R3: defensa a nivel de BD — solo caben 4 slots por sala
  UNIQUE (sala_id, slot),
  CHECK (slot BETWEEN 0 AND 3)
);

-- Igual que lo ejecutado en producción: API pública bloqueada,
-- acceso solo para el backend (rol administrador de Postgres)
ALTER TABLE salas ENABLE ROW LEVEL SECURITY;
ALTER TABLE jugadores ENABLE ROW LEVEL SECURITY;