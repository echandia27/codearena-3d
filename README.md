CodeArena 3D 🚁
Videojuego multijugador de arena 3D donde hasta 4 jugadores controlan drones.La mecánica central: para usar habilidades especiales (Boost, Attack,Shield) hay que responder correctamente preguntas tecnológicas generadaspor IA según el tema de la sala.

Cómo se gana (R7 en una frase): cada respuesta correcta suma 25 puntos;gana el primero en llegar a 100, o al cumplirse los 5 minutos quien tengamás puntos (empate si igualan).

Stack
Capa	Tecnología
Frontend	Angular 21 + TypeScript + Three.js
Tiempo real	Socket.IO (WebSockets)
Backend	NestJS
Base de datos	PostgreSQL (Supabase)
IA	Google Gemini (gemini-2.5-flash)
Arquitectura
┌───────────────────────────────┐│     NAVEGADOR (x4 pestañas)   ││   ANGULAR + THREE.JS          ││  · Arena 3D, drone, teclado   ││  · UI: lobby, preguntas, HUD  ││  · Cliente de Socket.IO       │└──────────────┬────────────────┘               │ HTTP REST → crear/consultar salas               │ WebSocket → todo el juego en tiempo real┌──────────────▼────────────────┐│        SERVIDOR NESTJS        ││  · REST: salas (validación)   ││  · Gateway Socket.IO: difusión││  · Motor de combate (HP,      ││    habilidades, puntaje)      ││  · Servicio IA + respaldos    │└─────────┬─────────────┬───────┘          │ SQL         │ HTTPS┌─────────▼─────────┐ ┌───▼──────────────┐│  SUPABASE         │ │  GEMINI          ││  salas, jugadores │ │  preguntas por   ││                   │ │  tema de la sala │└───────────────────┘ └──────────────────┘
Principio central: el servidor es la única fuente de verdad. El clientesolo envía intenciones (moverse, pedir habilidad, responder) y el servidorvalida, aplica y difunde a toda la sala. Esto resuelve de raíz la anti-trampa(el índice correcto de las preguntas jamás viaja al cliente), laconcurrencia y la sincronización.

Reglas del juego
Parámetro	Valor
HP inicial	100
Attack	−25 HP al objetivo
Muerte	−25 pts (mínimo 0) + respawn de 3 s con 100 HP
Boost	velocidad ×2 por 5 s
Shield	inmune a Attack por 5 s
Respuesta correcta	+25 pts (persistidos en Postgres)
Timer de respuesta	20 s (vencerlo = habilidad no activada)
Victoria	100 pts, o mayor puntaje a los 5 min
Máximo de jugadores	4 por sala
Reglas del enunciado → implementación y verificación
Regla	Implementación	Verificación
R1 código único	4 caracteres (alfabeto sin 0/O/1/I/L) + UNIQUE(codigo) en BD + reintento ante colisión	Unirse a código inexistente → 404 claro
R2 máx 4 jugadores	Validación de cupo en transacción; 5° rechazado con mensaje claro	test-r3.mjs
R3 concurrencia	SELECT … FOR UPDATE sobre la sala + UNIQUE(sala_id, slot) como defensa a nivel de BD	test-r3.mjs: dos uniones simultáneas al último cupo → exactamente 1 entra
R4 formato de pregunta	esPreguntaValida() (función pura): enunciado, opciones múltiples, única correcta, dificultad	test-ia.mjs
R5 fallos de IA	Errores tipados (no_responde / formato / limite / config), timeouts con AbortController, pool de respaldo en memoria, mensajes entendibles	test-ia.mjs simula los 3 fallos
R6 habilidad ↔ pregunta	La pregunta se genera al solicitar la habilidad; solo el acierto la activa; timeout = fallo	test-partida.mjs: inválida/incorrecta/timeout → sin habilidad
R7 puntaje y victoria	+25 persistidos en Postgres; al llegar a 100 → partida:finalizada + sala FINISHED	test-partida.mjs --full
R8 estado sincronizado	Gateway difunde sala:estado y partida:estado; posiciones a 10 Hz con identidad estampada por el servidor; interpolación en el cliente	test-socket.mjs, test-posiciones.mjs
R9 desconexión	handleDisconnect marca conectado=false y difunde; la partida sigue; reconexión con sala:conectar	test-socket.mjs + juego real
Decisiones de diseño (y su justificación)
Servidor = única fuente de verdad. El cliente nunca decide nada del juego; previene trampas y condiciones de carrera.
REST para gestión de salas; WebSocket para el juego. HTTP para lo puntual (crear/consultar), canal persistente para lo vivo.
Partidas en memoria; puntaje en Postgres. La vida/efectos son estado efímero que muere con la partida; el puntaje es medible y auditable (R7).
Posiciones efímeras a 10 Hz + interpolación. Enviar 60 fps inundaría la red; el cliente suaviza el movimiento entre actualizaciones.
El índice correcto jamás sale del servidor. Un jugador con DevTools abierta no puede ver la respuesta.
Inicio: cuando todos los conectados marcan "Listo" → la sala pasa a PLAYING → cuenta regresiva de 5 s. Las uniones se bloquean en PLAYING.
IA con dos modos. IA_MODO=test activa un stub determinista local (para desarrollo y pruebas sin cuota); sin esa variable, se usa Gemini real. Los tests de integración no dependen de servicios externos (lección aprendida: cuota, latencia y 429/503 hacían los tests inestables).
sessionStorage por pestaña para simular multijugador en un mismo navegador (una pestaña = un jugador), con reconexión vía sala:conectar.
Slot del jugador define su color y punto de aparición en la arena.
Limpieza de arranque: al iniciar el backend, las salas en PLAYING de ejecuciones anteriores se marcan FINISHED (sus partidas murieron con el proceso).
Cómo ejecutar
1. Base de datos (Supabase)
Crea un proyecto en supabase.com
SQL Editor → pega y ejecuta backend/sql/schema.sql
Del botón Connect (Session pooler) toma host/usuario para el .env
2. Backend
cd backendnpm install
Crea backend/.env (no se sube al repo):

DB_HOST=<host del Session pooler de Supabase>DB_PORT=5432DB_USER=postgres.<project-ref>DB_PASSWORD=<tu contraseña de BD>DB_NAME=postgresGEMINI_API_KEY=<tu clave de Google AI Studio># IA_MODO=test        ← descomenta para desarrollo sin cuota de IA
npm run start:dev   # API en http://localhost:3001
3. Frontend
npm installng serve            # App en http://localhost:4200
4. Jugar
Abre http://localhost:4200 en varias pestañas: una crea la sala(elige el tema) y las demás se unen con el código de 4 caracteres.Todos marcan Listo → cuenta regresiva → arena.

Scripts de verificación
Desde backend/, con el servidor corriendo:

Script	Qué verifica
node test-db.mjs	Conexión a la base de datos
node test-r3.mjs	R3: dos jugadores compiten simultáneamente por el último cupo
node test-socket.mjs	Salas por WS, flujo Listo→countdown→PLAYING, unión tardía rechazada
node test-posiciones.mjs	Relevo de posiciones (R8) sin eco al emisor
node test-ia.mjs	IA real: generación validada (R4) y fallos manejados (R5)
node test-partida.mjs [--full]	Motor de combate completo (R6, R7) — usar con IA_MODO=test
node test-modelos.mjs	Diagnóstico: modelos Gemini disponibles para tu clave
Estructura del repositorio
codearena-3d/├── src/                    # Frontend Angular + Three.js│   ├── environments/       # Configuración (URL del backend)│   └── app/│       ├── arena/          # Escena 3D, drones, HUD de combate│       ├── pages/          # Home (crear/unirse), Lobby, Resultados│       └── services/       # Controls (teclado), GameSession (Socket.IO + signals)└── backend/                # API NestJS + Gateway Socket.IO    ├── sql/schema.sql      # Esquema de BD reproducible    └── src/        ├── salas/          # CRUD de salas, gateway, motor de partida        ├── ia/             # Gemini + pool de respaldo + stub de test        └── database/       # Pool de conexiones pg