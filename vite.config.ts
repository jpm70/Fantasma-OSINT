import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Política de seguridad de contenidos solo en la build publicada (en desarrollo
// rompería el HMR de Vite). La app consulta APIs públicas desde el navegador
// (GitHub, RDAP, que redirige al servidor de cada registro, DoH, Shodan InternetDB…)
// y, si se configura, un proxy propio: por eso connect-src admite cualquier https.
// Ningún script ni estilo se carga de fuera salvo las fuentes de Google.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://gravatar.com https://*.gravatar.com",
  'connect-src https:',
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const cspPlugin = (): Plugin => ({
  name: 'fantasma-osint-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
});

// base relativa: la misma build sirve en la raíz y en
// https://unfantasmaenelsistema.github.io/Fantasma-OSINT/
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), cspPlugin()],
});
