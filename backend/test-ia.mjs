/**
 * Prueba de la Sesión 4A: generación de preguntas con IA.
 * Verifica: R4 (formato validado) y R5 (fallos con respaldo o mensaje entendible).
 * Uso: node test-ia.mjs  (backend corriendo en :3001 y GEMINI_API_KEY en .env)
 */
const BASE = 'http://localhost:3001';

/** Espejo local de la validación R4 (verificamos que lo que sale cumple). */
function esPreguntaValida(p) {
  return (
    p &&
    typeof p.enunciado === 'string' &&
    p.enunciado.trim().length >= 10 &&
    Array.isArray(p.opciones) &&
    p.opciones.length >= 2 &&
    p.opciones.every((o) => typeof o === 'string' && o.trim().length > 0) &&
    Number.isInteger(p.indiceCorrecto) &&
    p.indiceCorrecto >= 0 &&
    p.indiceCorrecto < p.opciones.length &&
    ['facil', 'media', 'dificil'].includes(p.dificultad)
  );
}

async function pedir(qs = '') {
  const res = await fetch(`${BASE}/ia/pregunta${qs}`);
  return { status: res.status, data: await res.json() };
}

async function main() {
  const tema = 'WebSockets';

  // 0) Precalentar el pool de respaldo (3 preguntas en paralelo)
  const pre = await fetch(`${BASE}/ia/precalentar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tema }),
  });
  const preData = await pre.json();
  console.log(`✅ Pool de respaldo: ${preData.guardadas} pregunta(s) precargada(s) para "${tema}"`);
  if (preData.guardadas === 0) {
    console.log('⚠️  No se precargó nada — revisa GEMINI_API_KEY en backend/.env');
  }

  // 1) Generación normal + validación local del formato (R4)
  const normal = await pedir(`?tema=${encodeURIComponent(tema)}`);
  if (normal.status === 503 && normal.data.error === 'config') {
    throw new Error('Falta GEMINI_API_KEY: agrégala a backend/.env y reinicia el backend');
  }
  if (normal.status !== 200 || !esPreguntaValida(normal.data)) {
    throw new Error(`La pregunta generada no es válida: ${JSON.stringify(normal.data)}`);
  }
  console.log('✅ R4: pregunta generada y con formato válido');
  console.log(`   "${normal.data.enunciado}"`);
  console.log(`   dificultad: ${normal.data.dificultad} — ${normal.data.opciones.length} opciones (correcta: índice ${normal.data.indiceCorrecto})`);

  // 2) Tema inválido → 400 con mensaje claro
  const malTema = await pedir('?tema=Cobol');
  if (malTema.status !== 400) throw new Error(`Esperaba 400, llegó ${malTema.status}`);
  console.log('✅ Tema inválido rechazado con mensaje claro');

  // 3) Los tres fallos de R5, simulados (reproducibles, sin esperar a que Google falle)
  for (const fallo of ['no_responde', 'limite', 'formato']) {
    const r = await pedir(`?tema=${encodeURIComponent(tema)}&forzarError=${fallo}`);
    if (r.status === 200 && esPreguntaValida(r.data)) {
      console.log(`✅ R5: fallo simulado (${fallo}) → pregunta de RESPALDO entregada`);
    } else if (r.status === 503 && r.data.error === fallo && typeof r.data.mensaje === 'string') {
      console.log(`✅ R5: fallo simulado (${fallo}) sin respaldo → mensaje entendible: "${r.data.mensaje}"`);
    } else {
      throw new Error(`Fallo (${fallo}) mal manejado: status ${r.status} — ${JSON.stringify(r.data)}`);
    }
  }

  console.log('\n🎉 Sesión 4A verificada: IA generando, formato validado, fallos manejados');
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});