/**
 * Diagnóstico: lista los modelos de Gemini disponibles para TU API key.
 * Uso: node test-modelos.mjs  (requiere GEMINI_API_KEY en .env)
 */
import 'dotenv/config';

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error('❌ Falta GEMINI_API_KEY en backend/.env');
  process.exit(1);
}

const res = await fetch(
  'https://generativelanguage.googleapis.com/v1beta/models',
  { headers: { 'x-goog-api-key': key } },
);
const data = await res.json();

if (!res.ok) {
  console.error('❌ Error de la API:', JSON.stringify(data, null, 2));
  process.exit(1);
}

console.log('Modelos disponibles que pueden generar contenido:\n');
for (const m of data.models ?? []) {
  if (m.supportedGenerationMethods?.includes('generateContent')) {
    console.log(`  ${m.name}`);
  }
}
console.log('\n→ Copia uno que diga "flash" (sin el prefijo "models/")');
console.log('  y ponlo en la constante MODELO de gemini.service.ts');