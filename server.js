// Load .env if present (no extra dependency)
const _envPath = require('path').join(__dirname, '.env');
if (require('fs').existsSync(_envPath)) {
  require('fs').readFileSync(_envPath, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const [k, ...v] = trimmed.split('=');
    if (k?.trim()) process.env[k.trim()] = v.join('=').trim();
  });
  console.log('OpenAI disponible:', !!process.env.OPENAI_API_KEY);
}

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const db = require('./database');

const SYSTEM_PROMPT = `Eres un asistente comercial experto del CRM GNL (Gas Natural Licuado) de Naturgy.
Respondes siempre en español, de forma clara, útil y conversacional.

Tienes acceso al contexto completo de la base de datos del CRM (entidades, contactos, oportunidades, documentos, países).
Usa esos datos para responder, analizar, comparar y dar recomendaciones comerciales.

Puedes y debes:
- Analizar el pipeline comercial y dar insights sobre oportunidades
- Resumir el estado de relaciones con contrapartes y países
- Sugerir próximos pasos comerciales basándote en los datos disponibles
- Responder preguntas generales sobre el sector LNG/GNL y mercados de gas
- Hacer cálculos, comparativas y rankings con los datos del CRM
- Dar contexto de mercado cuando sea relevante

Formato: usa **negrita** para destacar cifras, nombres y fechas clave. Usa listas cuando ayude a la claridad.
Si no tienes datos suficientes sobre algo muy específico, dilo brevemente y ofrece lo que sí puedes aportar.`;

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============ ACCESS KEY AUTH ============
const ACCESS_KEY = process.env.ACCESS_KEY || '';

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GNL CRM - Acceso</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<style>
  body { font-family: 'Segoe UI', system-ui, sans-serif; margin: 0; background: #F5F5F5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .login-box { background: #fff; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,.1); padding: 48px 40px; text-align: center; max-width: 380px; width: 90%; }
  .login-box h1 { color: #0078D4; margin: 0 0 8px; font-size: 1.6rem; }
  .login-box .sub { color: #605E5C; margin-bottom: 32px; font-size: .9rem; }
  .login-box input { width: 100%; padding: 12px 16px; border: 2px solid #EDEBE9; border-radius: 8px; font-size: 1rem; outline: none; box-sizing: border-box; }
  .login-box input:focus { border-color: #0078D4; }
  .login-box button { margin-top: 16px; width: 100%; padding: 12px; background: #0078D4; color: #fff; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; }
  .login-box button:hover { background: #106EBE; }
  .error { color: #D13438; margin-top: 12px; font-size: .85rem; display: none; }
</style></head>
<body><div class="login-box">
  <h1><i class="fas fa-fire-flame-curved"></i> GNL CRM</h1>
  <p class="sub">Introduce la clave de acceso</p>
  <form method="POST" action="/login">
    <input type="password" name="key" placeholder="Clave de acceso" autofocus required>
    <button type="submit"><i class="fas fa-sign-in-alt"></i> Entrar</button>
    <p class="error" id="err">ERROR_MSG</p>
  </form>
</div></body></html>`;

app.post('/login', (req, res) => {
  if (req.body.key === ACCESS_KEY) {
    res.cookie('crm_access', ACCESS_KEY, { httpOnly: true, maxAge: 7 * 24 * 3600 * 1000, sameSite: 'lax' });
    return res.redirect('/');
  }
  res.status(401).send(LOGIN_HTML.replace('display: none', 'display: block').replace('ERROR_MSG', 'Clave incorrecta'));
});

app.get('/logout', (req, res) => {
  res.clearCookie('crm_access');
  res.redirect('/');
});

// Cookie parser (manual, sin dependencia)
function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(c => { const [k, ...v] = c.split('='); if (k) cookies[k.trim()] = v.join('=').trim(); });
  return cookies;
}

// Gate: si hay ACCESS_KEY configurada, exigir clave
if (ACCESS_KEY) {
  app.use((req, res, next) => {
    // Permitir POST /login sin cookie
    if (req.path === '/login') return next();
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.crm_access === ACCESS_KEY) return next();
    // No autenticado → mostrar login
    res.status(401).send(LOGIN_HTML.replace('ERROR_MSG', ''));
  });
  console.log('Acceso protegido con clave compartida');
}

app.use(express.static(path.join(__dirname, 'public')));

// File upload config
const upload = multer({ dest: path.join(__dirname, 'uploads') });

// Init database
db.initSchema();
db.runMigrations();

// ============ DASHBOARD ============
app.get('/api/dashboard', (req, res) => {
  res.json(db.getDashboardStats());
});

// ============ SEARCH ============
app.get('/api/search', (req, res) => {
  const q = req.query.q || '';
  res.json(db.searchEntities(q));
});

// ============ ENTITY DETAIL ============
app.get('/api/entidades/:codigo/detail', (req, res) => {
  const detail = db.getEntityDetail(req.params.codigo);
  if (!detail) return res.status(404).json({ error: 'Entidad no encontrada' });
  res.json(detail);
});

// ============ GENERIC CRUD ROUTES ============
const tableConfig = {
  paises: { table: 'Pais', pk: 'CodigoPaisNormalizado' },
  entidades: { table: 'Entidades', pk: 'CodigoEntidad' },
  contactos: { table: 'Contactos', pk: 'id', codeField: 'CodigoContacto', codePrefix: 'CON', requiresEntity: true },
  oportunidades: { table: 'Oportunidades', pk: 'id', codeField: 'CodigoOportunidad', codePrefix: 'OPO', requiresEntity: true },
  documentos: { table: 'Documentos', pk: 'id', codeField: 'CodigoDocumento', codePrefix: 'DOC', requiresEntity: true },
};

Object.entries(tableConfig).forEach(([route, config]) => {
  // GET all
  app.get(`/api/${route}`, (req, res) => {
    const filters = { ...req.query };
    delete filters._;
    res.json(db.getAll(config.table, filters));
  });

  // GET by id
  app.get(`/api/${route}/:id`, (req, res) => {
    const item = db.getById(config.table, config.pk, req.params.id);
    if (!item) return res.status(404).json({ error: 'No encontrado' });
    res.json(item);
  });

  // POST create
  app.post(`/api/${route}`, (req, res) => {
    try {
      // Validate CodigoEntidad if required
      if (config.requiresEntity) {
        if (!req.body.CodigoEntidad || req.body.CodigoEntidad.trim() === '') {
          return res.status(400).json({ error: 'CodigoEntidad es obligatorio' });
        }
        if (!db.entityExists(req.body.CodigoEntidad)) {
          return res.status(400).json({ error: `La entidad "${req.body.CodigoEntidad}" no existe` });
        }
      }
      // Auto-generate code if applicable
      if (config.codeField && (!req.body[config.codeField] || req.body[config.codeField].trim() === '')) {
        req.body[config.codeField] = db.generateNextCode(config.table, config.codeField, config.codePrefix);
      }
      const result = db.insert(config.table, req.body);
      res.json({ ok: true, id: result.lastInsertRowid });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // PUT update
  app.put(`/api/${route}/:id`, (req, res) => {
    try {
      // Validate CodigoEntidad if required and changed
      if (config.requiresEntity && req.body.CodigoEntidad) {
        if (req.body.CodigoEntidad.trim() === '') {
          return res.status(400).json({ error: 'CodigoEntidad es obligatorio' });
        }
        if (!db.entityExists(req.body.CodigoEntidad)) {
          return res.status(400).json({ error: `La entidad "${req.body.CodigoEntidad}" no existe` });
        }
      }
      db.update(config.table, config.pk, req.params.id, req.body);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // DELETE
  app.delete(`/api/${route}/:id`, (req, res) => {
    try {
      const depError = db.checkDeleteDependencies(config.table, req.params.id);
      if (depError) return res.status(409).json({ error: depError });
      db.remove(config.table, config.pk, req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
});

// ============ IMPORT EXCEL ============
app.post('/api/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se ha proporcionado archivo' });

    const wb = XLSX.readFile(req.file.path);
    const results = {};

    const sheetMap = {
      'Pais': 'Pais',
      'Entidades': 'Entidades',
      'Contactos': 'Contactos',
      'Oportunidades': 'Oportunidades',
      'Documentos': 'Documentos',
    };

    // Import order matters due to foreign keys
    const importOrder = ['Pais', 'Entidades', 'Contactos', 'Oportunidades', 'Documentos'];

    for (const sheetName of importOrder) {
      if (wb.SheetNames.includes(sheetName)) {
        const ws = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(ws);
        // Clean null/undefined values
        const cleanedRows = rows.map(row => {
          const clean = {};
          Object.entries(row).forEach(([k, v]) => {
            clean[k] = v != null ? String(v) : null;
          });
          return clean;
        });
        results[sheetName] = db.bulkImport(sheetName, cleanedRows);
      }
    }

    // Clean up uploaded file
    const fs = require('fs');
    fs.unlinkSync(req.file.path);

    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ ENTIDADES LIST (lightweight for dropdowns) ============
app.get('/api/entidades-list', (req, res) => {
  res.json(db.getEntidadesList());
});

app.get('/api/paises-list', (req, res) => {
  res.json(db.getPaisesList());
});

// ============ AI CHAT ============
app.get('/api/ai/status', (req, res) => {
  res.json({ openaiAvailable: !!process.env.OPENAI_API_KEY });
});

app.post('/api/ai/chat', async (req, res) => {
  const { message, useAI = false } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Mensaje vacío' });

  if (useAI && process.env.OPENAI_API_KEY) {
    try {
      const { OpenAI } = require('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const context = db.getCrmContext(message);
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT + '\n\n' + context },
          { role: 'user', content: message }
        ],
        max_tokens: 1500,
        temperature: 0.5
      });
      return res.json({ response: completion.choices[0].message.content, mode: 'openai' });
    } catch (e) {
      const fallback = db.processAiQuery(message);
      return res.json({ response: '⚠️ OpenAI no disponible, usando respuesta básica.\n\n' + fallback, mode: 'fallback' });
    }
  }

  try {
    const response = db.processAiQuery(message);
    res.json({ response, mode: 'basic' });
  } catch (e) {
    res.status(500).json({ error: 'Error procesando consulta: ' + e.message });
  }
});

// SPA fallback
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`CRM GNL corriendo en http://localhost:${PORT}`);
});
