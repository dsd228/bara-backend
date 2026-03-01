# Bara & Co — Backend de Pagos

Backend Node.js/Express para procesar pagos de la tienda Bara & Co.

## Rutas disponibles

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/api/crear-pedido` | Crea pedido + preferencia MercadoPago |
| POST | `/api/mp-webhook` | Recibe notificaciones de pago de MP |
| POST | `/api/pedido-manual` | Actualiza estado de pedidos manuales |
| GET | `/api/pedido/:id` | Consulta estado de un pedido |

## Setup local

```bash
# 1. Clonar el repo
git clone https://github.com/dsd228/bara-backend.git
cd bara-backend

# 2. Instalar dependencias
npm install

# 3. Configurar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales reales

# 4. Correr en desarrollo
npm run dev
```

## Deploy en Render

1. Conectar este repo en render.com → New Web Service
2. Build Command: `npm install`
3. Start Command: `node server.js`
4. Agregar las variables de entorno en Render → Environment

## Variables de entorno necesarias en Render

- `MP_ACCESS_TOKEN` → Tu Access Token de MercadoPago
- `BACKEND_URL` → URL de este backend en Render
- `FRONTEND_URL` → URL de tu frontend (GitHub Pages)
- `WA_LOCAL` → Número WhatsApp del local

## Credenciales MercadoPago

Obtenerlas en: https://www.mercadopago.com.ar/developers/panel
