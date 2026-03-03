require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const app  = express();
const PORT = process.env.PORT || 3000;

const mpClient     = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN, options: { timeout: 5000 } });
const WA_LOCAL     = process.env.WA_LOCAL     || '5493525614281';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://baraandco.com';
const BACKEND_URL  = process.env.BACKEND_URL  || 'https://bara-backend.onrender.com';

app.use(cors({
  origin: [
    FRONTEND_URL,
    'https://baraandco.com',
    'https://baraandco.com.ar',
    'https://www.baraandco.com',
    'https://www.baraandco.com.ar',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    /\.github\.io$/,
  ],
  methods: ['GET', 'POST'],
  credentials: true,
}));

app.use('/api/mp-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

const pedidos       = new Map();
const guardarPedido = (id, d) => pedidos.set(id, { ...d, updatedAt: new Date().toISOString() });
const obtenerPedido = id => pedidos.get(id);
const fmt           = n => '$' + Number(n).toLocaleString('es-AR');
const generarId     = () => `BC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2,6).toUpperCase()}`;

async function notificarLocalWA(pedido) {
  try {
    const ml = { mp:'MercadoPago', card:'Tarjeta', naranja:'Naranja X', transfer:'Transferencia', posnet:`Posnet ${pedido.posnetTarjeta||''}`, cash:'Efectivo', wa:'WhatsApp' };
    const items = (pedido.items||[]).map(i => `• ${i.nombre}${i.talle?` (${i.talle})`:''}${i.color?` · ${i.color}`:''} x${i.qty||1} — ${fmt(i.precio*(i.qty||1))}`).join('\n');
    const msg = encodeURIComponent(`🔔 NUEVO PEDIDO — Bara & Co\n🆔 ${pedido.id}\n👤 ${pedido.nombre}\n📧 ${pedido.email}${pedido.telefono?'\n📱 '+pedido.telefono:''}\n\n${items}\n\n💰 Total: ${fmt(pedido.total)}\n📦 Envío: ${pedido.envio}\n💳 Pago: ${ml[pedido.metodoPago]||pedido.metodoPago}`);
    pedido.waNotifUrl = `https://wa.me/${WA_LOCAL}?text=${msg}`;
  } catch(e) { console.error('notifWA:', e.message); }
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'bara-backend', mp: process.env.MP_ACCESS_TOKEN ? 'OK' : 'FALTA TOKEN', ts: new Date().toISOString() }));

app.post('/api/crear-pedido', async (req, res) => {
  try {
    const { nombre, email, telefono, items, total, envio, modoEnvio, metodoPago, posnetTarjeta } = req.body;
    if (!nombre || !email || !items?.length) return res.status(400).json({ error: 'Faltan datos' });
    if (!email.includes('@')) return res.status(400).json({ error: 'Email inválido' });

    const id     = generarId();
    const pedido = { id, nombre, email, telefono, items, total, envio, modoEnvio, metodoPago, posnetTarjeta, estado: 'pendiente', createdAt: new Date().toISOString() };
    guardarPedido(id, pedido);

    if (metodoPago === 'mp' || metodoPago === 'card') {
      const result = await new Preference(mpClient).create({ body: {
        items: items.map(i => ({ id: i.id||i.nombre, title: `${i.nombre}${i.talle?` - ${i.talle}`:''}`, quantity: i.qty||1, unit_price: Number(i.precio), currency_id: 'ARS', picture_url: i.imagen||undefined })),
        payer: { name: nombre, email },
        external_reference: id,
        back_urls: { success: `${FRONTEND_URL}/success.html?pedido=${id}&estado=aprobado`, failure: `${FRONTEND_URL}/checkout.html?error=pago_fallido`, pending: `${FRONTEND_URL}/success.html?pedido=${id}&estado=pendiente` },
        auto_return: 'approved',
        notification_url: `${BACKEND_URL}/api/mp-webhook`,
        statement_descriptor: 'BARA & CO',
      }});
      return res.json({ ok: true, pedidoId: id, initPoint: result.init_point, sandbox: result.sandbox_init_point });
    }

    await notificarLocalWA(pedido);
    guardarPedido(id, pedido);
    return res.json({ ok: true, pedidoId: id, waNotifUrl: pedido.waNotifUrl });

  } catch(err) {
    console.error('crear-pedido:', err.message);
    res.status(500).json({ error: 'Error interno', detail: err.message });
  }
});

app.post('/api/mp-webhook', async (req, res) => {
  try {
    const body = JSON.parse(req.body.toString());
    if (body.type !== 'payment') return res.sendStatus(200);
    const payment = await new Payment(mpClient).get({ id: body.data?.id });
    const pedido  = obtenerPedido(payment.external_reference);
    if (pedido) {
      pedido.estado = payment.status === 'approved' ? 'pagado' : payment.status;
      pedido.mpPaymentId = payment.id;
      guardarPedido(payment.external_reference, pedido);
      if (payment.status === 'approved') { await notificarLocalWA(pedido); guardarPedido(payment.external_reference, pedido); }
      console.log(`Pago ${payment.status} — ${payment.external_reference}`);
    }
    res.sendStatus(200);
  } catch(err) { res.sendStatus(200); }
});

app.post('/api/pedido-manual', (req, res) => {
  const p = obtenerPedido(req.body.pedidoId);
  if (!p) return res.status(404).json({ error: 'No encontrado' });
  p.estado = req.body.estado || 'pendiente_confirmacion';
  guardarPedido(req.body.pedidoId, p);
  res.json({ ok: true, estado: p.estado });
});

app.get('/api/pedido/:id', (req, res) => {
  const p = obtenerPedido(req.params.id);
  if (!p) return res.status(404).json({ error: 'No encontrado' });
  res.json({ nombre: p.nombre, email: p.email, estado: p.estado, metodoPago: p.metodoPago, total: p.total, items: p.items, createdAt: p.createdAt, waNotifUrl: p.waNotifUrl });
});

app.listen(PORT, () => console.log(`Bara & Co Backend · Puerto ${PORT} · MP: ${process.env.MP_ACCESS_TOKEN ? 'OK' : 'FALTA TOKEN'}`));
