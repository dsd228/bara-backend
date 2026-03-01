/**
 * server.js — Bara & Co Backend
 * ─────────────────────────────────────────────────────────────
 * Maneja:
 *   POST /api/crear-pedido     → crea preferencia en MercadoPago
 *   POST /api/mp-webhook       → recibe confirmación de pago de MP
 *   POST /api/pedido-manual    → registra pedidos de transferencia/posnet/efectivo
 *   GET  /api/pedido/:id       → consulta estado de un pedido
 *   GET  /health               → health check para Render
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ══════════════════════════════════════════════════
   CONFIGURACIÓN
══════════════════════════════════════════════════ */

// MercadoPago SDK
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
  options: { timeout: 5000 }
});

// WhatsApp del local (para notificaciones)
const WA_LOCAL = process.env.WA_LOCAL || '5493525614281';

// URL del frontend (para redirecciones después del pago)
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://bara-co.github.io';

/* ══════════════════════════════════════════════════
   MIDDLEWARES
══════════════════════════════════════════════════ */
app.use(cors({
  origin: [
    FRONTEND_URL,
    'http://localhost:5500',  // Live Server local
    'http://127.0.0.1:5500',
    /\.github\.io$/,           // cualquier github pages
  ],
  methods: ['GET', 'POST'],
  credentials: true
}));

// Necesitamos el raw body para verificar firma del webhook de MP
app.use('/api/mp-webhook', express.raw({ type: 'application/json' }));

// Para el resto, JSON normal
app.use(express.json());

/* ══════════════════════════════════════════════════
   BASE DE DATOS EN MEMORIA
   (simple para empezar — guardamos pedidos en RAM)
   En producción avanzada: reemplazar con MongoDB/Postgres
══════════════════════════════════════════════════ */
const pedidos = new Map();

function guardarPedido(id, data) {
  pedidos.set(id, { ...data, updatedAt: new Date().toISOString() });
}

function obtenerPedido(id) {
  return pedidos.get(id);
}

/* ══════════════════════════════════════════════════
   UTILIDADES
══════════════════════════════════════════════════ */
const fmt = n => '$' + Number(n).toLocaleString('es-AR');

function generarIdPedido() {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `BC-${ts}-${rand}`;
}

// Notificación al local por WhatsApp (abre link wa.me — el local lo recibe)
// Nota: esto genera la URL pero el local debe tener WhatsApp Web abierto.
// Para envío automático real se puede integrar Twilio o Meta Cloud API luego.
async function notificarLocalWA(pedido) {
  try {
    const metodoLabel = {
      mp:       'MercadoPago ✅',
      naranja:  'Naranja X',
      transfer: 'Transferencia bancaria',
      posnet:   `Posnet · ${pedido.posnetTarjeta || ''}`,
      cash:     'Efectivo',
      wa:       'Por WhatsApp'
    };

    const items = (pedido.items || []).map(i =>
      `• ${i.nombre}${i.talle ? ` (${i.talle})` : ''}${i.color ? ` · ${i.color}` : ''} ×${i.qty || 1} — ${fmt(i.precio * (i.qty || 1))}`
    ).join('\n');

    const estadoEmoji = pedido.estado === 'pagado' ? '✅ PAGADO' : '⏳ PENDIENTE';

    const msg = encodeURIComponent(
      `🔔 *NUEVO PEDIDO ${estadoEmoji} — Bara & Co*\n` +
      `🆔 Pedido: ${pedido.id}\n\n` +
      `👤 *${pedido.nombre}*\n` +
      `📧 ${pedido.email}` + (pedido.telefono ? `\n📱 ${pedido.telefono}` : '') + `\n\n` +
      `*Productos:*\n${items}\n\n` +
      `💰 *Total: ${fmt(pedido.total)}*\n` +
      `📦 *Envío:* ${pedido.envio}\n` +
      `💳 *Pago:* ${metodoLabel[pedido.metodoPago] || pedido.metodoPago}\n\n` +
      `_${new Date().toLocaleString('es-AR')}_`
    );

    // Guardamos la URL de notificación en el pedido para que el frontend la abra
    pedido.waNotifUrl = `https://wa.me/${WA_LOCAL}?text=${msg}`;
  } catch(e) {
    console.error('Error armando notif WA:', e.message);
  }
}

/* ══════════════════════════════════════════════════
   RUTAS
══════════════════════════════════════════════════ */

// ── Health check ────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'bara-backend', ts: new Date().toISOString() });
});

// ── Crear pedido + preferencia MercadoPago ───────
app.post('/api/crear-pedido', async (req, res) => {
  try {
    const {
      nombre, email, telefono,
      items, total, envio, modoEnvio,
      metodoPago, posnetTarjeta
    } = req.body;

    // Validaciones básicas
    if (!nombre || !email || !items || !items.length) {
      return res.status(400).json({ error: 'Faltan datos obligatorios' });
    }
    if (!email.includes('@')) {
      return res.status(400).json({ error: 'Email inválido' });
    }

    const idPedido = generarIdPedido();

    // Guardar pedido como pendiente
    const pedido = {
      id: idPedido,
      nombre, email, telefono,
      items, total, envio, modoEnvio,
      metodoPago, posnetTarjeta,
      estado: 'pendiente',
      createdAt: new Date().toISOString()
    };
    guardarPedido(idPedido, pedido);

    // Si el método es MercadoPago → crear preferencia
    if (metodoPago === 'mp') {
      const preference = new Preference(mpClient);

      const mpItems = items.map(item => ({
        id:          item.id || item.nombre,
        title:       `${item.nombre}${item.talle ? ` - ${item.talle}` : ''}${item.color ? ` / ${item.color}` : ''}`,
        quantity:    item.qty || 1,
        unit_price:  Number(item.precio),
        currency_id: 'ARS',
        picture_url: item.imagen || undefined,
      }));

      const prefData = {
        items:          mpItems,
        payer:          { name: nombre, email },
        external_reference: idPedido,
        back_urls: {
          success: `${FRONTEND_URL}/success.html?pedido=${idPedido}&estado=aprobado`,
          failure: `${FRONTEND_URL}/checkout.html?error=pago_fallido`,
          pending: `${FRONTEND_URL}/success.html?pedido=${idPedido}&estado=pendiente`,
        },
        auto_return:        'approved',
        notification_url:   `${process.env.BACKEND_URL}/api/mp-webhook`,
        statement_descriptor: 'BARA & CO',
        metadata: { pedido_id: idPedido },
      };

      const result = await preference.create({ body: prefData });

      // Devolver init_point al frontend
      return res.json({
        ok:        true,
        pedidoId:  idPedido,
        initPoint: result.init_point,  // URL de pago real
        sandbox:   result.sandbox_init_point, // URL de prueba
      });
    }

    // Si es otro método (naranja, transfer, posnet, cash, wa)
    await notificarLocalWA(pedido);
    guardarPedido(idPedido, pedido); // actualizar con waNotifUrl

    return res.json({
      ok:         true,
      pedidoId:   idPedido,
      waNotifUrl: pedido.waNotifUrl, // el frontend abre esto
    });

  } catch(err) {
    console.error('Error crear-pedido:', err);
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
});

// ── Webhook de MercadoPago ───────────────────────
// MP llama a esta URL cuando el pago se procesa
app.post('/api/mp-webhook', async (req, res) => {
  try {
    const body = req.body.toString ? JSON.parse(req.body.toString()) : req.body;

    // Solo nos interesan las notificaciones de tipo "payment"
    if (body.type !== 'payment') {
      return res.sendStatus(200);
    }

    const paymentId = body.data?.id;
    if (!paymentId) return res.sendStatus(200);

    // Consultar el pago en MercadoPago para verificarlo
    const paymentApi = new Payment(mpClient);
    const payment    = await paymentApi.get({ id: paymentId });

    const pedidoId = payment.external_reference;
    const estado   = payment.status; // 'approved', 'pending', 'rejected'

    if (!pedidoId) return res.sendStatus(200);

    const pedido = obtenerPedido(pedidoId);
    if (!pedido) {
      console.warn('Webhook: pedido no encontrado', pedidoId);
      return res.sendStatus(200);
    }

    // Actualizar estado del pedido
    pedido.estado        = estado === 'approved' ? 'pagado' : estado;
    pedido.mpPaymentId   = paymentId;
    pedido.mpStatus      = estado;
    pedido.mpDetail      = payment.status_detail;
    pedido.metodoPago    = 'mp';
    guardarPedido(pedidoId, pedido);

    console.log(`✅ Pago ${estado} — Pedido ${pedidoId} — MP Payment ${paymentId}`);

    // Si fue aprobado, notificar al local
    if (estado === 'approved') {
      await notificarLocalWA(pedido);
      guardarPedido(pedidoId, pedido);
      console.log(`🔔 Notificación WA generada para pedido ${pedidoId}`);
    }

    res.sendStatus(200); // MP requiere 200 rápido

  } catch(err) {
    console.error('Error webhook MP:', err.message);
    res.sendStatus(200); // Siempre 200 a MP para evitar reintentos
  }
});

// ── Registrar pedido manual (naranja, transfer, posnet, cash) ──
app.post('/api/pedido-manual', async (req, res) => {
  try {
    const { pedidoId, estado } = req.body;
    const pedido = obtenerPedido(pedidoId);
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

    pedido.estado = estado || 'pendiente_confirmacion';
    guardarPedido(pedidoId, pedido);

    res.json({ ok: true, pedidoId, estado: pedido.estado });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Consultar estado de un pedido ────────────────
app.get('/api/pedido/:id', (req, res) => {
  const pedido = obtenerPedido(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

  // No exponer datos sensibles
  const { nombre, email, estado, metodoPago, total, items, createdAt, waNotifUrl } = pedido;
  res.json({ nombre, email, estado, metodoPago, total, items, createdAt, waNotifUrl });
});


// ── Exponer Public Key al frontend ──────────────────
app.get('/api/mp-public-key', (req, res) => {
  const key = process.env.MP_PUBLIC_KEY || '';
  if (!key || key.includes('REEMPLAZAR')) {
    return res.status(503).json({ error: 'Credenciales no configuradas' });
  }
  res.json({ publicKey: key });
});

// ── Procesar pago de tarjeta (MP Bricks) ────────────
app.post('/api/pagar-tarjeta', async (req, res) => {
  try {
    const {
      token, issuer_id, payment_method_id,
      transaction_amount, installments, payer,
      nombre, telefono, items, envio, modoEnvio
    } = req.body;

    if (!token || !transaction_amount) {
      return res.status(400).json({ error: 'Faltan datos del pago' });
    }

    const paymentApi = new Payment(mpClient);

    const paymentData = {
      transaction_amount: Number(transaction_amount),
      token,
      description: `Pedido Bara & Co — ${nombre || 'Cliente'}`,
      installments:       Number(installments) || 1,
      payment_method_id,
      issuer_id,
      payer: {
        email:          payer?.email,
        identification: payer?.identification,
      },
    };

    const payment = await paymentApi.create({ body: paymentData });

    const idPedido = generarIdPedido();
    const pedido = {
      id:          idPedido,
      nombre,
      email:       payer?.email,
      telefono,
      items,
      total:       transaction_amount,
      envio,
      modoEnvio,
      metodoPago:  'card',
      mpPaymentId: payment.id,
      mpStatus:    payment.status,
      mpDetail:    payment.status_detail,
      estado:      payment.status === 'approved' ? 'pagado' : payment.status,
      createdAt:   new Date().toISOString(),
    };
    guardarPedido(idPedido, pedido);

    console.log(`💳 Pago tarjeta ${payment.status} — ${idPedido} — MP ${payment.id}`);

    // Notificar al local si fue aprobado
    if (payment.status === 'approved') {
      await notificarLocalWA(pedido);
      guardarPedido(idPedido, pedido);
    }

    res.json({
      ok:         true,
      pedidoId:   idPedido,
      status:     payment.status,
      detail:     payment.status_detail,
      waNotifUrl: pedido.waNotifUrl,
    });

  } catch(err) {
    console.error('Error pagar-tarjeta:', err);
    // Errores conocidos de MP
    const mpErr = err?.cause?.[0]?.description || err.message || 'Error al procesar el pago';
    res.status(400).json({ error: mpErr });
  }
});

/* ══════════════════════════════════════════════════
   ARRANCAR SERVIDOR
══════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║   Bara & Co Backend · Puerto ${PORT}    ║
  ╚═══════════════════════════════════════╝
  MP Access Token: ${process.env.MP_ACCESS_TOKEN ? '✅ configurado' : '❌ FALTA configurar'}
  Frontend URL:    ${FRONTEND_URL}
  Backend URL:     ${process.env.BACKEND_URL || '⚠️  configurar en .env'}
  `);
});

/* ══════════════════════════════════════════════════
   MIDDLEWARES
══════════════════════════════════════════════════ */
app.use(cors({
  origin: [
    FRONTEND_URL,
    'http://localhost:5500',  // Live Server local
    'http://127.0.0.1:5500',
    /\.github\.io$/,           // cualquier github pages
  ],
  methods: ['GET', 'POST'],
  credentials: true
}));

// Necesitamos el raw body para verificar firma del webhook de MP
app.use('/api/mp-webhook', express.raw({ type: 'application/json' }));

// Para el resto, JSON normal
app.use(express.json());

/* ══════════════════════════════════════════════════
   BASE DE DATOS EN MEMORIA
   (simple para empezar — guardamos pedidos en RAM)
   En producción avanzada: reemplazar con MongoDB/Postgres
══════════════════════════════════════════════════ */
const pedidos = new Map();

function guardarPedido(id, data) {
  pedidos.set(id, { ...data, updatedAt: new Date().toISOString() });
}

function obtenerPedido(id) {
  return pedidos.get(id);
}

/* ══════════════════════════════════════════════════
   UTILIDADES
══════════════════════════════════════════════════ */
const fmt = n => '$' + Number(n).toLocaleString('es-AR');

function generarIdPedido() {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `BC-${ts}-${rand}`;
}

// Notificación al local por WhatsApp (abre link wa.me — el local lo recibe)
// Nota: esto genera la URL pero el local debe tener WhatsApp Web abierto.
// Para envío automático real se puede integrar Twilio o Meta Cloud API luego.
async function notificarLocalWA(pedido) {
  try {
    const metodoLabel = {
      mp:       'MercadoPago ✅',
      naranja:  'Naranja X',
      transfer: 'Transferencia bancaria',
      posnet:   `Posnet · ${pedido.posnetTarjeta || ''}`,
      cash:     'Efectivo',
      wa:       'Por WhatsApp'
    };

    const items = (pedido.items || []).map(i =>
      `• ${i.nombre}${i.talle ? ` (${i.talle})` : ''}${i.color ? ` · ${i.color}` : ''} ×${i.qty || 1} — ${fmt(i.precio * (i.qty || 1))}`
    ).join('\n');

    const estadoEmoji = pedido.estado === 'pagado' ? '✅ PAGADO' : '⏳ PENDIENTE';

    const msg = encodeURIComponent(
      `🔔 *NUEVO PEDIDO ${estadoEmoji} — Bara & Co*\n` +
      `🆔 Pedido: ${pedido.id}\n\n` +
      `👤 *${pedido.nombre}*\n` +
      `📧 ${pedido.email}` + (pedido.telefono ? `\n📱 ${pedido.telefono}` : '') + `\n\n` +
      `*Productos:*\n${items}\n\n` +
      `💰 *Total: ${fmt(pedido.total)}*\n` +
      `📦 *Envío:* ${pedido.envio}\n` +
      `💳 *Pago:* ${metodoLabel[pedido.metodoPago] || pedido.metodoPago}\n\n` +
      `_${new Date().toLocaleString('es-AR')}_`
    );

    // Guardamos la URL de notificación en el pedido para que el frontend la abra
    pedido.waNotifUrl = `https://wa.me/${WA_LOCAL}?text=${msg}`;
  } catch(e) {
    console.error('Error armando notif WA:', e.message);
  }
}

/* ══════════════════════════════════════════════════
   RUTAS
══════════════════════════════════════════════════ */

// ── Health check ────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'bara-backend', ts: new Date().toISOString() });
});

// ── Crear pedido + preferencia MercadoPago ───────
app.post('/api/crear-pedido', async (req, res) => {
  try {
    const {
      nombre, email, telefono,
      items, total, envio, modoEnvio,
      metodoPago, posnetTarjeta
    } = req.body;

    // Validaciones básicas
    if (!nombre || !email || !items || !items.length) {
      return res.status(400).json({ error: 'Faltan datos obligatorios' });
    }
    if (!email.includes('@')) {
      return res.status(400).json({ error: 'Email inválido' });
    }

    const idPedido = generarIdPedido();

    // Guardar pedido como pendiente
    const pedido = {
      id: idPedido,
      nombre, email, telefono,
      items, total, envio, modoEnvio,
      metodoPago, posnetTarjeta,
      estado: 'pendiente',
      createdAt: new Date().toISOString()
    };
    guardarPedido(idPedido, pedido);

    // Si el método es MercadoPago → crear preferencia
    if (metodoPago === 'mp') {
      const preference = new Preference(mpClient);

      const mpItems = items.map(item => ({
        id:          item.id || item.nombre,
        title:       `${item.nombre}${item.talle ? ` - ${item.talle}` : ''}${item.color ? ` / ${item.color}` : ''}`,
        quantity:    item.qty || 1,
        unit_price:  Number(item.precio),
        currency_id: 'ARS',
        picture_url: item.imagen || undefined,
      }));

      const prefData = {
        items:          mpItems,
        payer:          { name: nombre, email },
        external_reference: idPedido,
        back_urls: {
          success: `${FRONTEND_URL}/success.html?pedido=${idPedido}&estado=aprobado`,
          failure: `${FRONTEND_URL}/checkout.html?error=pago_fallido`,
          pending: `${FRONTEND_URL}/success.html?pedido=${idPedido}&estado=pendiente`,
        },
        auto_return:        'approved',
        notification_url:   `${process.env.BACKEND_URL}/api/mp-webhook`,
        statement_descriptor: 'BARA & CO',
        metadata: { pedido_id: idPedido },
      };

      const result = await preference.create({ body: prefData });

      // Devolver init_point al frontend
      return res.json({
        ok:        true,
        pedidoId:  idPedido,
        initPoint: result.init_point,  // URL de pago real
        sandbox:   result.sandbox_init_point, // URL de prueba
      });
    }

    // Si es otro método (naranja, transfer, posnet, cash, wa)
    await notificarLocalWA(pedido);
    guardarPedido(idPedido, pedido); // actualizar con waNotifUrl

    return res.json({
      ok:         true,
      pedidoId:   idPedido,
      waNotifUrl: pedido.waNotifUrl, // el frontend abre esto
    });

  } catch(err) {
    console.error('Error crear-pedido:', err);
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
});

// ── Webhook de MercadoPago ───────────────────────
// MP llama a esta URL cuando el pago se procesa
app.post('/api/mp-webhook', async (req, res) => {
  try {
    const body = req.body.toString ? JSON.parse(req.body.toString()) : req.body;

    // Solo nos interesan las notificaciones de tipo "payment"
    if (body.type !== 'payment') {
      return res.sendStatus(200);
    }

    const paymentId = body.data?.id;
    if (!paymentId) return res.sendStatus(200);

    // Consultar el pago en MercadoPago para verificarlo
    const paymentApi = new Payment(mpClient);
    const payment    = await paymentApi.get({ id: paymentId });

    const pedidoId = payment.external_reference;
    const estado   = payment.status; // 'approved', 'pending', 'rejected'

    if (!pedidoId) return res.sendStatus(200);

    const pedido = obtenerPedido(pedidoId);
    if (!pedido) {
      console.warn('Webhook: pedido no encontrado', pedidoId);
      return res.sendStatus(200);
    }

    // Actualizar estado del pedido
    pedido.estado        = estado === 'approved' ? 'pagado' : estado;
    pedido.mpPaymentId   = paymentId;
    pedido.mpStatus      = estado;
    pedido.mpDetail      = payment.status_detail;
    pedido.metodoPago    = 'mp';
    guardarPedido(pedidoId, pedido);

    console.log(`✅ Pago ${estado} — Pedido ${pedidoId} — MP Payment ${paymentId}`);

    // Si fue aprobado, notificar al local
    if (estado === 'approved') {
      await notificarLocalWA(pedido);
      guardarPedido(pedidoId, pedido);
      console.log(`🔔 Notificación WA generada para pedido ${pedidoId}`);
    }

    res.sendStatus(200); // MP requiere 200 rápido

  } catch(err) {
    console.error('Error webhook MP:', err.message);
    res.sendStatus(200); // Siempre 200 a MP para evitar reintentos
  }
});

// ── Registrar pedido manual (naranja, transfer, posnet, cash) ──
app.post('/api/pedido-manual', async (req, res) => {
  try {
    const { pedidoId, estado } = req.body;
    const pedido = obtenerPedido(pedidoId);
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

    pedido.estado = estado || 'pendiente_confirmacion';
    guardarPedido(pedidoId, pedido);

    res.json({ ok: true, pedidoId, estado: pedido.estado });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Consultar estado de un pedido ────────────────
app.get('/api/pedido/:id', (req, res) => {
  const pedido = obtenerPedido(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

  // No exponer datos sensibles
  const { nombre, email, estado, metodoPago, total, items, createdAt, waNotifUrl } = pedido;
  res.json({ nombre, email, estado, metodoPago, total, items, createdAt, waNotifUrl });
});

/* ══════════════════════════════════════════════════
   ARRANCAR SERVIDOR
══════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║   Bara & Co Backend · Puerto ${PORT}    ║
  ╚═══════════════════════════════════════╝
  MP Access Token: ${process.env.MP_ACCESS_TOKEN ? '✅ configurado' : '❌ FALTA configurar'}
  Frontend URL:    ${FRONTEND_URL}
  Backend URL:     ${process.env.BACKEND_URL || '⚠️  configurar en .env'}
  `);
});
