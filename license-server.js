// Simple License Server (Node.js/Express)
// NOTE: For production, move licenses.json OUTSIDE any static web root.

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // Change in production
const DATA_DIR = path.join(__dirname, 'server_data');
const DATA_FILE = path.join(DATA_DIR, 'licenses.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ customers: [] }, null, 2));

function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); } catch (e) { return { customers: [] }; }
}
function writeData(obj) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2));
}

function genId(prefix='id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
}
function genLicenseKey() {
  function block() { return Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4).padEnd(4,'X'); }
  return `LIC-${block()}-${block()}-${block()}-${block()}`;
}
function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}
function isExpired(iso) {
  return new Date(iso).getTime() <= Date.now();
}

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE'], allowedHeaders: ['Content-Type','X-Admin-Auth'] }));
app.use(express.json());

// Simple admin auth middleware
function requireAdmin(req, res, next) {
  const hdr = req.headers['x-admin-auth'];
  if (!hdr || hdr !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Create customer & license
app.post('/api/customers', requireAdmin, (req, res) => {
  const { name, email, months = 6, maxDevices = 2 } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });
  const db = readData();
  const customer = {
    id: genId('cust'),
    name,
    email,
    licenseKey: genLicenseKey(),
    status: 'active',
    maxDevices,
    createdAt: new Date().toISOString(),
    expiresAt: addMonths(new Date().toISOString(), Number(months) || 6),
    activations: []
  };
  db.customers.push(customer);
  writeData(db);
  res.json(customer);
});

// List customers
app.get('/api/customers', requireAdmin, (req, res) => {
  const db = readData();
  res.json({ customers: db.customers });
});

// Renew expiry
app.put('/api/customers/:id/renew', requireAdmin, (req, res) => {
  const { months = 3 } = req.body || {};
  const db = readData();
  const c = db.customers.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const baseDate = isExpired(c.expiresAt) ? new Date().toISOString() : c.expiresAt;
  c.expiresAt = addMonths(baseDate, Number(months) || 3);
  writeData(db);
  res.json(c);
});

// Ban / Unban
app.put('/api/customers/:id/ban', requireAdmin, (req, res) => {
  const { banned = true } = req.body || {};
  const db = readData();
  const c = db.customers.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  c.status = banned ? 'banned' : (isExpired(c.expiresAt) ? 'expired' : 'active');
  writeData(db);
  res.json(c);
});

// Activate license for a device
app.post('/api/licenses/activate', (req, res) => {
  const { licenseKey, deviceId } = req.body || {};
  if (!licenseKey || !deviceId) return res.status(400).json({ error: 'licenseKey and deviceId required' });
  const db = readData();
  const c = db.customers.find(x => x.licenseKey === licenseKey);
  if (!c) return res.status(404).json({ status: 'invalid', error: 'invalid license' });
  if (c.status === 'banned') return res.status(403).json({ status: 'banned' });
  if (isExpired(c.expiresAt)) {
    c.status = 'expired';
    writeData(db);
    return res.status(403).json({ status: 'expired', expiresAt: c.expiresAt });
  }
  const existing = c.activations.find(a => a.deviceId === deviceId);
  if (!existing) {
    if ((c.activations?.length || 0) >= c.maxDevices) {
      return res.status(403).json({ status: 'limit_exceeded', maxDevices: c.maxDevices });
    }
    c.activations.push({ deviceId, activatedAt: new Date().toISOString(), lastSeen: new Date().toISOString() });
  } else {
    existing.lastSeen = new Date().toISOString();
  }
  c.status = 'active';
  writeData(db);
  res.json({ status: 'active', expiresAt: c.expiresAt, deviceId, customerName: c.name });
});

// Verify license status
app.get('/api/licenses/verify', (req, res) => {
  const licenseKey = req.query.key;
  const deviceId = req.query.deviceId;
  if (!licenseKey || !deviceId) return res.status(400).json({ error: 'key and deviceId required' });
  const db = readData();
  const c = db.customers.find(x => x.licenseKey === licenseKey);
  if (!c) return res.status(404).json({ status: 'invalid' });
  const activation = c.activations.find(a => a.deviceId === deviceId);
  if (!activation) return res.status(403).json({ status: 'not_activated' });
  activation.lastSeen = new Date().toISOString();
  let status = c.status;
  if (status !== 'banned') status = isExpired(c.expiresAt) ? 'expired' : 'active';
  c.status = status;
  writeData(db);
  res.json({ status, expiresAt: c.expiresAt });
});

app.listen(PORT, () => {
  console.log(`License server running on http://localhost:${PORT}`);
});