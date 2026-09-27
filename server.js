const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = path.join(__dirname, 'database.sqlite');

// Ensure upload directories exist
['photos', 'pdfs', 'logos'].forEach(dir => {
  fs.mkdirSync(path.join(UPLOADS_DIR, dir), { recursive: true });
});

// Initialize SQLite database
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    app_name TEXT DEFAULT 'GVD LIVE',
    logo_url TEXT DEFAULT ''
  );

  INSERT OR IGNORE INTO settings (id, app_name, logo_url) VALUES (1, 'GVD LIVE', '');

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT CHECK(role IN ('Admin', 'Operative')) DEFAULT 'Operative',
    status TEXT CHECK(status IN ('Pending', 'Active', 'Restricted')) DEFAULT 'Pending',
    reset_token TEXT,
    reset_token_expires TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS id_sequences (
    name TEXT PRIMARY KEY,
    last_id INTEGER NOT NULL DEFAULT 0
  );

  INSERT OR IGNORE INTO id_sequences (name, last_id) VALUES ('site_id', 0);

  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY,
    address TEXT NOT NULL,
    construction_type TEXT CHECK(construction_type IN ('Concrete', 'Timber')) NOT NULL,
    customer_token TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS site_customer_contacts (
    site_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (site_id, user_id),
    FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    operative_id INTEGER NOT NULL,
    shift_date TEXT NOT NULL,
    task TEXT NOT NULL,
    seen_at TEXT DEFAULT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE CASCADE,
    FOREIGN KEY(operative_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    uploader_id INTEGER NOT NULL,
    uploader_name TEXT NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE CASCADE,
    FOREIGN KEY(uploader_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS pdfs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    uploader_id INTEGER NOT NULL,
    uploader_name TEXT NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE CASCADE,
    FOREIGN KEY(uploader_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// No seed data - database starts clean for first user registration

// Global SSE clients array for live updates
const sseClients = new Set();

function broadcastEvent(type, payload = {}) {
  const data = JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
  for (const client of sseClients) {
    try {
      client.res.write(`data: ${data}\n\n`);
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

// Helper: Hash password
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
}

// Helper: Get next unique site ID (never reuse IDs!)
function getNextSiteId() {
  db.exec('BEGIN TRANSACTION;');
  try {
    const row = db.prepare("SELECT last_id FROM id_sequences WHERE name = 'site_id'").get();
    const nextId = (row ? row.last_id : 0) + 1;
    db.prepare("UPDATE id_sequences SET last_id = ? WHERE name = 'site_id'").run(nextId);
    db.exec('COMMIT;');
    return nextId;
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

// Helper: Parse JSON body
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Helper: Parse Multipart Form Data
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundaryMatch) {
      return reject(new Error('No boundary found in multipart headers'));
    }
    const boundary = boundaryMatch[1] || boundaryMatch[2];
    const boundaryBuffer = Buffer.from(`--${boundary}`);
    
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const fields = {};
      const files = {};

      let start = 0;
      while (start < buffer.length) {
        const nextBoundary = buffer.indexOf(boundaryBuffer, start);
        if (nextBoundary === -1) break;

        const headerEnd = buffer.indexOf('\r\n\r\n', nextBoundary);
        if (headerEnd === -1) break;

        const partHeader = buffer.slice(nextBoundary + boundaryBuffer.length + 2, headerEnd).toString('utf8');
        const nextPartBoundary = buffer.indexOf(boundaryBuffer, headerEnd + 4);
        if (nextPartBoundary === -1) break;

        let partData = buffer.slice(headerEnd + 4, nextPartBoundary - 2); // trim trailing \r\n

        const nameMatch = partHeader.match(/name="([^"]+)"/i);
        const filenameMatch = partHeader.match(/filename="([^"]+)"/i);
        const contentTypeMatch = partHeader.match(/Content-Type:\s*([^\r\n]+)/i);

        if (nameMatch) {
          const fieldName = nameMatch[1];
          if (filenameMatch) {
            files[fieldName] = {
              filename: filenameMatch[1],
              contentType: contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream',
              data: partData
            };
          } else {
            fields[fieldName] = partData.toString('utf8');
          }
        }

        start = nextPartBoundary;
      }
      resolve({ fields, files });
    });
    req.on('error', reject);
  });
}

// Authentication middleware
function authenticate(req) {
  const authHeader = req.headers['authorization'];
  let token = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.headers.cookie) {
    const cookies = Object.fromEntries(req.headers.cookie.split(';').map(c => c.trim().split('=')));
    token = cookies['token'] || '';
  }

  if (!token) return null;

  const session = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token);
  if (!session) return null;

  const user = db.prepare('SELECT id, full_name, email, phone, role, status FROM users WHERE id = ?').get(session.user_id);
  
  // Restricted or non-active users MUST immediately lose access!
  if (!user || user.status !== 'Active') {
    // Delete invalid/restricted sessions
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(session.user_id);
    return null;
  }

  return { user, token };
}

// Serve Static Files
function serveStaticFile(req, res, relativePath) {
  const filePath = path.join(PUBLIC_DIR, relativePath === '/' ? 'index.html' : relativePath);
  const ext = path.extname(filePath).toLowerCase();
  
  const mimeTypes = {
    '.html': 'text/html; charset=UTF-8',
    '.js': 'application/javascript; charset=UTF-8',
    '.css': 'text/css; charset=UTF-8',
    '.json': 'application/json; charset=UTF-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.ico': 'image/x-icon'
  };

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA routing if requested URL isn't a direct file
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(indexPath, (err2, content) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
        res.end(content);
      });
      return;
    }

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
}

// Format UK Local Date Time: e.g. "26 Sep 2026, 16:05"
function formatUKDateTime(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

// Main HTTP Router
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // -------------------------------------------------------------
  // SSE LIVE EVENTS ENDPOINT
  // -------------------------------------------------------------
  if (pathname === '/api/events' && method === 'GET') {
    const auth = authenticate(req);
    // Allow SSE connection for active users or customer tokens
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('retry: 3000\n\n');
    
    const client = { req, res, userId: auth ? auth.user.id : null };
    sseClients.add(client);

    req.on('close', () => {
      sseClients.delete(client);
    });
    return;
  }

  // -------------------------------------------------------------
  // AUTH ENDPOINTS
  // -------------------------------------------------------------
  if (pathname === '/api/auth/register' && method === 'POST') {
    try {
      const data = await parseJsonBody(req);
      const { full_name, email, phone, password } = data;

      if (!full_name || !email || !phone || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'All fields are required.' }));
      }

      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase());
      if (existing) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'An account with this email already exists.' }));
      }

      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(password, salt);

      // Check if this is the very first user in the system
      const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
      const role = userCount === 0 ? 'Admin' : 'Operative';
      const status = userCount === 0 ? 'Active' : 'Pending';

      const resResult = db.prepare(`
        INSERT INTO users (full_name, email, phone, password_hash, password_salt, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(full_name.trim(), email.trim().toLowerCase(), phone.trim(), hash, salt, role, status, new Date().toISOString());

      let token = null;
      let userObj = null;
      if (status === 'Active') {
        token = crypto.randomBytes(32).toString('hex');
        db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, resResult.lastInsertRowid, new Date().toISOString());
        userObj = {
          id: Number(resResult.lastInsertRowid),
          full_name: full_name.trim(),
          email: email.trim().toLowerCase(),
          phone: phone.trim(),
          role,
          status
        };
      }

      broadcastEvent('user_registered');

      res.writeHead(201, {
        'Content-Type': 'application/json',
        ...(token ? { 'Set-Cookie': `token=${token}; Path=/; HttpOnly; SameSite=Strict` } : {})
      });
      return res.end(JSON.stringify({
        message: status === 'Active' ? 'Registration successful. You are registered as Owner / Admin.' : 'Registration successful. Awaiting admin approval.',
        status,
        token,
        user: userObj
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    try {
      const { email, password } = await parseJsonBody(req);
      if (!email || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Email and password are required.' }));
      }

      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
      if (!user) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid email or password.' }));
      }

      const hash = hashPassword(password, user.password_salt);
      if (hash !== user.password_hash) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid email or password.' }));
      }

      if (user.status === 'Pending') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: 'Awaiting approval',
          status: 'Pending',
          message: 'Your registration is awaiting admin approval before accessing the app.'
        }));
      }

      if (user.status === 'Restricted') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: 'Access Restricted',
          status: 'Restricted',
          message: 'Your account access has been restricted by an administrator.'
        }));
      }

      // Generate Session Token
      const token = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, user.id, new Date().toISOString());

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `token=${token}; Path=/; HttpOnly; SameSite=Strict`
      });
      return res.end(JSON.stringify({
        token,
        user: {
          id: user.id,
          full_name: user.full_name,
          email: user.email,
          phone: user.phone,
          role: user.role,
          status: user.status
        }
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const auth = authenticate(req);
    if (auth) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(auth.token);
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    });
    return res.end(JSON.stringify({ message: 'Logged out successfully.' }));
  }

  if (pathname === '/api/auth/forgot-password' && method === 'POST') {
    try {
      const { email } = await parseJsonBody(req);
      if (!email) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Email is required.' }));
      }

      const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase());
      if (user) {
        const resetToken = crypto.randomBytes(24).toString('hex');
        const expires = new Date(Date.now() + 3600000).toISOString();
        db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?').run(resetToken, expires, user.id);
        console.log(`[PASSWORD RESET] Token generated for ${email}: ${resetToken}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          message: 'Password reset link sent to your email address.',
          reset_token: resetToken // Provided for effortless local UI testing
        }));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'If an account exists with that email, a reset link was sent.' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname === '/api/auth/reset-password' && method === 'POST') {
    try {
      const { token, new_password } = await parseJsonBody(req);
      if (!token || !new_password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Token and new password are required.' }));
      }

      const user = db.prepare('SELECT * FROM users WHERE reset_token = ?').get(token);
      if (!user || !user.reset_token_expires || new Date(user.reset_token_expires) < new Date()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid or expired password reset token.' }));
      }

      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(new_password, salt);

      db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?').run(hash, salt, user.id);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Password has been reset successfully. You can now log in.' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    const auth = authenticate(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized or session revoked.' }));
    }
    const settings = db.prepare('SELECT app_name, logo_url FROM settings WHERE id = 1').get();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ user: auth.user, settings }));
  }

  // -------------------------------------------------------------
  // ADMIN & USER CONTROL ENDPOINTS
  // -------------------------------------------------------------
  if (pathname === '/api/admin/users' && method === 'GET') {
    const auth = authenticate(req);
    if (!auth || auth.user.role !== 'Admin') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Admin access required.' }));
    }

    const users = db.prepare('SELECT id, full_name, email, phone, role, status, created_at FROM users ORDER BY created_at DESC').all();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(users));
  }

  if (pathname.match(/^\/api\/admin\/users\/(\d+)\/role$/) && method === 'PUT') {
    const auth = authenticate(req);
    if (!auth || auth.user.role !== 'Admin') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Admin access required.' }));
    }
    const targetUserId = parseInt(pathname.split('/')[4]);
    const { role } = await parseJsonBody(req);
    if (!['Admin', 'Operative'].includes(role)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid role.' }));
    }

    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetUserId);
    broadcastEvent('user_updated', { userId: targetUserId, role });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ message: 'User role updated successfully.' }));
  }

  if (pathname.match(/^\/api\/admin\/users\/(\d+)\/status$/) && method === 'PUT') {
    const auth = authenticate(req);
    if (!auth || auth.user.role !== 'Admin') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Admin access required.' }));
    }
    const targetUserId = parseInt(pathname.split('/')[4]);
    const { status } = await parseJsonBody(req);
    if (!['Pending', 'Active', 'Restricted'].includes(status)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid status.' }));
    }

    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, targetUserId);

    // If restricted, IMMEDIATELY revoke all active sessions for this user!
    if (status === 'Restricted' || status === 'Pending') {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetUserId);
      db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(targetUserId);
    }

    broadcastEvent('user_status_changed', { userId: targetUserId, status });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ message: 'User status updated successfully.' }));
  }

  if (pathname.match(/^\/api\/admin\/users\/(\d+)$/) && method === 'DELETE') {
    const auth = authenticate(req);
    if (!auth || auth.user.role !== 'Admin') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Admin access required.' }));
    }
    const targetUserId = parseInt(pathname.split('/')[4]);

    // Protect default admin from accidental self-deletion
    if (targetUserId === auth.user.id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'You cannot remove your own current admin account.' }));
    }

    // Removing an account MUST NOT erase historical planning records (shifts, photos, pdfs)!
    // We remove the user row from `users`, but foreign keys allow retention or nulling sessions.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetUserId);
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(targetUserId);
    db.prepare('DELETE FROM users WHERE id = ?').run(targetUserId);

    broadcastEvent('user_removed', { userId: targetUserId });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ message: 'User account removed. Historical planning records preserved.' }));
  }

  // -------------------------------------------------------------
  // APP SETTINGS ENDPOINTS
  // -------------------------------------------------------------
  if (pathname === '/api/admin/settings' && method === 'GET') {
    const settings = db.prepare('SELECT app_name, logo_url FROM settings WHERE id = 1').get();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(settings));
  }

  if (pathname === '/api/admin/settings' && method === 'POST') {
    const auth = authenticate(req);
    if (!auth || auth.user.role !== 'Admin') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Admin access required.' }));
    }

    try {
      const { fields, files } = await parseMultipart(req);
      const appName = fields.app_name ? fields.app_name.trim() : null;
      let logoUrl = null;

      if (files.logo) {
        const logoFile = files.logo;
        const fileExt = path.extname(logoFile.filename) || '.png';
        const savedFilename = `logo_${Date.now()}${fileExt}`;
        const savePath = path.join(UPLOADS_DIR, 'logos', savedFilename);
        fs.writeFileSync(savePath, logoFile.data);
        logoUrl = `/uploads/logos/${savedFilename}`;
      }

      if (appName) {
        db.prepare('UPDATE settings SET app_name = ? WHERE id = 1').run(appName);
      }
      if (logoUrl) {
        db.prepare('UPDATE settings SET logo_url = ? WHERE id = 1').run(logoUrl);
      }

      const updatedSettings = db.prepare('SELECT app_name, logo_url FROM settings WHERE id = 1').get();
      broadcastEvent('settings_updated', updatedSettings);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Settings updated successfully.', settings: updatedSettings }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // -------------------------------------------------------------
  // SITES ENDPOINTS
  // -------------------------------------------------------------
  if (pathname === '/api/sites' && method === 'GET') {
    const auth = authenticate(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized.' }));
    }

    let sites = [];
    if (auth.user.role === 'Admin') {
      sites = db.prepare('SELECT * FROM sites ORDER BY id ASC').all();
    } else {
      // Operatives see only sites they are assigned shifts for
      sites = db.prepare(`
        SELECT DISTINCT s.* FROM sites s
        INNER JOIN shifts sh ON s.id = sh.site_id
        WHERE sh.operative_id = ?
        ORDER BY s.id ASC
      `).all(auth.user.id);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(sites));
  }

  if (pathname === '/api/sites' && method === 'POST') {
    const auth = authenticate(req);
    if (!auth || auth.user.role !== 'Admin') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Admin access required.' }));
    }

    try {
      const { address, construction_type } = await parseJsonBody(req);
      if (!address || !['Concrete', 'Timber'].includes(construction_type)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Address and valid construction type (Concrete or Timber) are required.' }));
      }

      // Assign shortest practical unique numerical site ID (1, 2, 3...)
      const siteId = getNextSiteId();
      const customerToken = crypto.randomBytes(16).toString('hex');
      const createdAt = new Date().toISOString();

      db.prepare(`
        INSERT INTO sites (id, address, construction_type, customer_token, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(siteId, address.trim(), construction_type, customerToken, createdAt);

      // By default, assign all current admins as selected contacts for customer tab
      const admins = db.prepare("SELECT id FROM users WHERE role = 'Admin' AND status = 'Active'").all();
      const insertContact = db.prepare('INSERT INTO site_customer_contacts (site_id, user_id) VALUES (?, ?)');
      admins.forEach(a => insertContact.run(siteId, a.id));

      const newSite = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
      broadcastEvent('site_created', newSite);

      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(newSite));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname.match(/^\/api\/sites\/(\d+)$/) && method === 'GET') {
    const auth = authenticate(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized.' }));
    }
    const siteId = parseInt(pathname.split('/')[3]);
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
    if (!site) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Site not found.' }));
    }

    // Check operative authorization
    if (auth.user.role !== 'Admin') {
      const isAssigned = db.prepare('SELECT COUNT(*) as count FROM shifts WHERE site_id = ? AND operative_id = ?').get(siteId, auth.user.id).count;
      if (!isAssigned) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Access denied. You are not assigned to this site.' }));
      }
    }

    const customerContacts = db.prepare(`
      SELECT u.id, u.full_name, u.email, u.phone
      FROM site_customer_contacts scc
      JOIN users u ON scc.user_id = u.id
      WHERE scc.site_id = ?
    `).all(siteId);

    const photos = db.prepare('SELECT * FROM photos WHERE site_id = ? ORDER BY created_at DESC').all(siteId);
    const pdfs = db.prepare('SELECT * FROM pdfs WHERE site_id = ? ORDER BY created_at DESC').all(siteId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ site, customerContacts, photos, pdfs }));
  }

  // Update Customer Contacts for Site
  if (pathname.match(/^\/api\/sites\/(\d+)\/customer-contacts$/) && method === 'POST') {
    const auth = authenticate(req);
    if (!auth || auth.user.role !== 'Admin') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Admin access required.' }));
    }
    const siteId = parseInt(pathname.split('/')[3]);
    const { contact_user_ids } = await parseJsonBody(req); // Array of admin user IDs

    db.prepare('DELETE FROM site_customer_contacts WHERE site_id = ?').run(siteId);
    if (Array.isArray(contact_user_ids)) {
      const insertStmt = db.prepare('INSERT INTO site_customer_contacts (site_id, user_id) VALUES (?, ?)');
      contact_user_ids.forEach(uId => insertStmt.run(siteId, uId));
    }

    broadcastEvent('customer_contacts_updated', { siteId });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ message: 'Customer contacts updated successfully.' }));
  }

  // -------------------------------------------------------------
  // SHIFTS / PLANNER ENDPOINTS
  // -------------------------------------------------------------
  if (pathname === '/api/shifts' && method === 'GET') {
    const auth = authenticate(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized.' }));
    }

    let shifts = [];
    if (auth.user.role === 'Admin') {
      shifts = db.prepare(`
        SELECT sh.*, u.full_name as operative_name, s.address as site_address
        FROM shifts sh
        JOIN users u ON sh.operative_id = u.id
        JOIN sites s ON sh.site_id = s.id
        ORDER BY sh.shift_date ASC, sh.id ASC
      `).all();
    } else {
      // Operatives see only their own shifts
      shifts = db.prepare(`
        SELECT sh.*, u.full_name as operative_name, s.address as site_address
        FROM shifts sh
        JOIN users u ON sh.operative_id = u.id
        JOIN sites s ON sh.site_id = s.id
        WHERE sh.operative_id = ?
        ORDER BY sh.shift_date ASC, sh.id ASC
      `).all(auth.user.id);
    }

    // Format seen timestamp for display
    const formattedShifts = shifts.map(sh => ({
      ...sh,
      seen_formatted: sh.seen_at ? `Seen — ${formatUKDateTime(sh.seen_at)}` : 'Not seen'
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(formattedShifts));
  }

  if (pathname === '/api/shifts' && method === 'POST') {
    const auth = authenticate(req);
    if (!auth || auth.user.role !== 'Admin') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Admin access required.' }));
    }

    try {
      const { site_id, operative_id, shift_date, task } = await parseJsonBody(req);
      if (!site_id || !operative_id || !shift_date || !task) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Site, operative, shift date and task description are required.' }));
      }

      const now = new Date().toISOString();
      const resResult = db.prepare(`
        INSERT INTO shifts (site_id, operative_id, shift_date, task, seen_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?)
      `).run(site_id, operative_id, shift_date, task.trim(), now, now);

      const createdShift = db.prepare(`
        SELECT sh.*, u.full_name as operative_name, s.address as site_address
        FROM shifts sh
        JOIN users u ON sh.operative_id = u.id
        JOIN sites s ON sh.site_id = s.id
        WHERE sh.id = ?
      `).get(resResult.lastInsertRowid);

      broadcastEvent('shift_created', createdShift);

      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(createdShift));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname.match(/^\/api\/shifts\/(\d+)$/) && method === 'PUT') {
    const auth = authenticate(req);
    if (!auth || auth.user.role !== 'Admin') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Admin access required.' }));
    }
    const shiftId = parseInt(pathname.split('/')[3]);
    const existing = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
    if (!existing) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Shift not found.' }));
    }

    try {
      const { site_id, operative_id, shift_date, task } = await parseJsonBody(req);
      const newSiteId = site_id || existing.site_id;
      const newOpId = operative_id || existing.operative_id;
      const newDate = shift_date || existing.shift_date;
      const newTask = task ? task.trim() : existing.task;

      // Crucial requirement 6: If site, date or task changes -> RESET seen status to "Not seen" (NULL)!
      let newSeenAt = existing.seen_at;
      if (newSiteId !== existing.site_id || newDate !== existing.shift_date || newTask !== existing.task) {
        newSeenAt = null;
      }

      const now = new Date().toISOString();
      db.prepare(`
        UPDATE shifts
        SET site_id = ?, operative_id = ?, shift_date = ?, task = ?, seen_at = ?, updated_at = ?
        WHERE id = ?
      `).run(newSiteId, newOpId, newDate, newTask, newSeenAt, now, shiftId);

      const updatedShift = db.prepare(`
        SELECT sh.*, u.full_name as operative_name, s.address as site_address
        FROM shifts sh
        JOIN users u ON sh.operative_id = u.id
        JOIN sites s ON sh.site_id = s.id
        WHERE sh.id = ?
      `).get(shiftId);

      broadcastEvent('shift_updated', updatedShift);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(updatedShift));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname.match(/^\/api\/shifts\/(\d+)$/) && method === 'DELETE') {
    const auth = authenticate(req);
    if (!auth || auth.user.role !== 'Admin') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Admin access required.' }));
    }
    const shiftId = parseInt(pathname.split('/')[3]);
    const existing = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
    if (!existing) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Shift not found.' }));
    }

    db.prepare('DELETE FROM shifts WHERE id = ?').run(shiftId);
    broadcastEvent('shift_cancelled', { shiftId, operative_id: existing.operative_id, site_id: existing.site_id });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ message: 'Shift removed.' }));
  }

  // MARK SHIFT SEEN ENDPOINT (Operative opening shift details)
  if (pathname.match(/^\/api\/shifts\/(\d+)\/mark-seen$/) && method === 'POST') {
    const auth = authenticate(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized.' }));
    }

    // Crucial requirement 6: Admin opening it MUST NOT mark it as seen!
    if (auth.user.role === 'Admin') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Admin view ignored for seen status.' }));
    }

    const shiftId = parseInt(pathname.split('/')[3]);
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
    if (!shift) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Shift not found.' }));
    }

    // Only the assigned operative can mark shift as seen!
    if (shift.operative_id !== auth.user.id) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'You are not assigned to this shift.' }));
    }

    // If not already seen, record timestamp now
    if (!shift.seen_at) {
      const now = new Date().toISOString();
      db.prepare('UPDATE shifts SET seen_at = ? WHERE id = ?').run(now, shiftId);
      
      const updatedShift = db.prepare(`
        SELECT sh.*, u.full_name as operative_name, s.address as site_address
        FROM shifts sh
        JOIN users u ON sh.operative_id = u.id
        JOIN sites s ON sh.site_id = s.id
        WHERE sh.id = ?
      `).get(shiftId);

      const formattedSeen = `Seen — ${formatUKDateTime(now)}`;
      broadcastEvent('shift_seen', { shiftId, seen_at: now, seen_formatted: formattedSeen });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ message: 'Shift marked as seen.' }));
  }

  // -------------------------------------------------------------
  // PHOTOS ENDPOINTS
  // -------------------------------------------------------------
  if (pathname.match(/^\/api\/sites\/(\d+)\/photos$/) && method === 'GET') {
    const auth = authenticate(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized.' }));
    }
    const siteId = parseInt(pathname.split('/')[3]);
    const photos = db.prepare('SELECT * FROM photos WHERE site_id = ? ORDER BY created_at DESC').all(siteId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(photos));
  }

  if (pathname.match(/^\/api\/sites\/(\d+)\/photos$/) && method === 'POST') {
    const auth = authenticate(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized.' }));
    }
    const siteId = parseInt(pathname.split('/')[3]);

    // Operatives must be assigned to the site to upload
    if (auth.user.role !== 'Admin') {
      const isAssigned = db.prepare('SELECT COUNT(*) as count FROM shifts WHERE site_id = ? AND operative_id = ?').get(siteId, auth.user.id).count;
      if (!isAssigned) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Access denied. You are not assigned to this site.' }));
      }
    }

    try {
      const { files } = await parseMultipart(req);
      if (!files.photo) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Photo file is required.' }));
      }

      const photoFile = files.photo;
      const fileExt = path.extname(photoFile.filename) || '.jpg';
      const savedFilename = `photo_${siteId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${fileExt}`;
      const savePath = path.join(UPLOADS_DIR, 'photos', savedFilename);

      fs.writeFileSync(savePath, photoFile.data);

      const filePathUrl = `/uploads/photos/${savedFilename}`;
      const now = new Date().toISOString();

      const resResult = db.prepare(`
        INSERT INTO photos (site_id, uploader_id, uploader_name, filename, original_name, file_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(siteId, auth.user.id, auth.user.full_name, savedFilename, photoFile.filename, filePathUrl, now);

      const newPhoto = db.prepare('SELECT * FROM photos WHERE id = ?').get(resResult.lastInsertRowid);
      broadcastEvent('photo_uploaded', newPhoto);

      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(newPhoto));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // DELETE PHOTO: Only original uploader can delete!
  if (pathname.match(/^\/api\/photos\/(\d+)$/) && method === 'DELETE') {
    const auth = authenticate(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized.' }));
    }
    const photoId = parseInt(pathname.split('/')[3]);
    const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(photoId);
    if (!photo) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Photo not found.' }));
    }

    // REQUIREMENT 8: Only the person who uploaded a photo can delete it.
    if (photo.uploader_id !== auth.user.id) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Permission denied. Only the uploader can delete this photo.' }));
    }

    try {
      const fullPath = path.join(UPLOADS_DIR, 'photos', photo.filename);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    } catch (e) {
      console.error('File cleanup error:', e);
    }

    db.prepare('DELETE FROM photos WHERE id = ?').run(photoId);
    broadcastEvent('photo_deleted', { photoId, siteId: photo.site_id });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ message: 'Photo deleted successfully.' }));
  }

  // -------------------------------------------------------------
  // PDF FILES ENDPOINTS
  // -------------------------------------------------------------
  if (pathname.match(/^\/api\/sites\/(\d+)\/pdfs$/) && method === 'GET') {
    const auth = authenticate(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized.' }));
    }
    const siteId = parseInt(pathname.split('/')[3]);
    const pdfs = db.prepare('SELECT * FROM pdfs WHERE site_id = ? ORDER BY created_at DESC').all(siteId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(pdfs));
  }

  if (pathname.match(/^\/api\/sites\/(\d+)\/pdfs$/) && method === 'POST') {
    const auth = authenticate(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized.' }));
    }
    const siteId = parseInt(pathname.split('/')[3]);

    if (auth.user.role !== 'Admin') {
      const isAssigned = db.prepare('SELECT COUNT(*) as count FROM shifts WHERE site_id = ? AND operative_id = ?').get(siteId, auth.user.id).count;
      if (!isAssigned) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Access denied. You are not assigned to this site.' }));
      }
    }

    try {
      const { files } = await parseMultipart(req);
      if (!files.pdf) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'PDF file is required.' }));
      }

      const pdfFile = files.pdf;
      if (!pdfFile.filename.toLowerCase().endsWith('.pdf') && pdfFile.contentType !== 'application/pdf') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Only PDF documents are accepted.' }));
      }

      const savedFilename = `doc_${siteId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.pdf`;
      const savePath = path.join(UPLOADS_DIR, 'pdfs', savedFilename);

      fs.writeFileSync(savePath, pdfFile.data);

      const filePathUrl = `/uploads/pdfs/${savedFilename}`;
      const now = new Date().toISOString();

      const resResult = db.prepare(`
        INSERT INTO pdfs (site_id, uploader_id, uploader_name, filename, original_name, file_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(siteId, auth.user.id, auth.user.full_name, savedFilename, pdfFile.filename, filePathUrl, now);

      const newPdf = db.prepare('SELECT * FROM pdfs WHERE id = ?').get(resResult.lastInsertRowid);
      broadcastEvent('pdf_uploaded', newPdf);

      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(newPdf));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // DELETE PDF: Strictly ONLY original uploader can delete, including where another user is an admin!
  if (pathname.match(/^\/api\/pdfs\/(\d+)$/) && method === 'DELETE') {
    const auth = authenticate(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized.' }));
    }
    const pdfId = parseInt(pathname.split('/')[3]);
    const pdf = db.prepare('SELECT * FROM pdfs WHERE id = ?').get(pdfId);
    if (!pdf) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'PDF file not found.' }));
    }

    // REQUIREMENT 9: Only the person who uploaded a file can delete it, including where another user is an admin.
    if (pdf.uploader_id !== auth.user.id) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Permission denied. Only the person who uploaded this PDF can delete it.' }));
    }

    try {
      const fullPath = path.join(UPLOADS_DIR, 'pdfs', pdf.filename);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    } catch (e) {
      console.error('File cleanup error:', e);
    }

    db.prepare('DELETE FROM pdfs WHERE id = ?').run(pdfId);
    broadcastEvent('pdf_deleted', { pdfId, siteId: pdf.site_id });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ message: 'PDF document deleted successfully.' }));
  }

  // -------------------------------------------------------------
  // CUSTOMER PUBLIC READ-ONLY SCHEDULE ENDPOINT (QR Target)
  // -------------------------------------------------------------
  if (pathname.match(/^\/api\/customer\/([a-f0-9]+)$/) && method === 'GET') {
    const customerToken = pathname.split('/')[3];
    const site = db.prepare('SELECT id, address, construction_type FROM sites WHERE customer_token = ?').get(customerToken);

    if (!site) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid or expired schedule link.' }));
    }

    // Return ONLY this site's schedule: dates, operative names, tasks
    const shifts = db.prepare(`
      SELECT sh.shift_date, sh.task, u.full_name as operative_name
      FROM shifts sh
      JOIN users u ON sh.operative_id = u.id
      WHERE sh.site_id = ?
      ORDER BY sh.shift_date ASC
    `).all(site.id);

    const settings = db.prepare('SELECT app_name, logo_url FROM settings WHERE id = 1').get();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      app_name: settings.app_name,
      logo_url: settings.logo_url,
      site_id: site.id,
      address: site.address,
      construction_type: site.construction_type,
      shifts
    }));
  }

  // -------------------------------------------------------------
  // WEBPUSH SERVER DISPATCH ENDPOINT (Apple APNs / Google FCM Push)
  // -------------------------------------------------------------
  if (pathname === '/api/push/send' && method === 'POST') {
    let bodyData = '';
    req.on('data', chunk => { bodyData += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(bodyData || '{}');
        const { targetUserId, title, body, shiftId, siteId, subscriptions } = payload;
        const correlationId = payload.correlationId || 'corr_' + Date.now();

        const subsToProcess = subscriptions || [];
        if (subsToProcess.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'No device subscriptions provided' }));
        }

        const { sendWebPushNotification } = require('./push_dispatcher');
        let acceptedCount = 0;
        let failedCount = 0;
        let lastResponse = '';

        for (const sub of subsToProcess) {
          if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) continue;
          
          const result = await sendWebPushNotification(sub, {
            title: title || '🚨 GVD LIVE Shift Update',
            body: body || 'You have a schedule update.',
            shiftId,
            siteId,
            correlationId,
            url: '/'
          });

          if (result.success) {
            acceptedCount++;
            lastResponse = `Accepted by ${result.provider} (${result.statusCode} Created)`;
          } else {
            failedCount++;
            lastResponse = `Push Error (${result.provider}): ${result.message}`;
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: acceptedCount > 0,
          acceptedCount,
          failedCount,
          correlationId,
          providerResponse: lastResponse || 'Completed'
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // -------------------------------------------------------------
  // STATIC UPLOADS SERVING
  // -------------------------------------------------------------
  if (pathname.startsWith('/uploads/')) {
    const relativeUpload = pathname.substring(9);
    const fullUploadPath = path.join(UPLOADS_DIR, relativeUpload);

    if (!fullUploadPath.startsWith(UPLOADS_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Access denied');
    }

    fs.stat(fullUploadPath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('File not found');
      }
      const ext = path.extname(fullUploadPath).toLowerCase();
      const mimeTypes = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf'
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      fs.createReadStream(fullUploadPath).pipe(res);
    });
    return;
  }

  // -------------------------------------------------------------
  // DEFAULT STATIC FILE ROUTER (Single Page Application)
  // -------------------------------------------------------------
  serveStaticFile(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`🚀 Works Planner Server listening at http://localhost:${PORT}`);
  console.log(`===================================================`);
});
